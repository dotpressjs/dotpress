import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createMailer,
  MailMessageError,
  MailSendError,
  type MessageOptions,
} from '../src/index.js'
import { createBrevoProvider } from '../src/providers/brevo.js'
import {
  bodyOf,
  fullMessage,
  json,
  minimalMessage,
  mockFetch,
} from './fetch-mock.js'
import { startHttpServer, type Reply } from './http-server.js'

const created = () =>
  json(201, { messageId: '<201798300811.5787683@relay.example.com>' })

const setup = (response: () => Response = created) => {
  const fetchMock = mockFetch(response)
  const mailer = createMailer({
    provider: createBrevoProvider({ apiKey: 'xkeysib-1', fetch: fetchMock }),
    from: 'Example <noreply@example.com>',
  })
  return { fetchMock, mailer }
}

describe('Brevo provider', () => {
  it('posts the message to the transactional email API', async () => {
    const { fetchMock, mailer } = setup()
    const result = await mailer.sendMessage(fullMessage)
    expect(result).toEqual({
      messageId: '<201798300811.5787683@relay.example.com>',
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.brevo.com/v3/smtp/email')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': 'xkeysib-1',
      },
    })
    // Brevo has no metadata field: it is ignored.
    expect(bodyOf(fetchMock)).toStrictEqual({
      sender: { email: 'noreply@example.com', name: 'Example' },
      to: [
        { email: 'ada@example.com', name: 'Ada Lovelace' },
        { email: 'grace@example.com' },
      ],
      cc: [{ email: 'charles@example.com', name: 'Charles' }],
      bcc: [{ email: 'archive@example.com' }],
      replyTo: { email: 'support@example.com', name: 'Support' },
      subject: 'Your invoice',
      htmlContent: '<p>Hello</p>',
      textContent: 'Hello',
      attachment: [
        { name: 'invoice.pdf', content: 'AQID' },
        { name: 'notes.txt', content: 'Tm90ZXMgw6k=' },
      ],
      headers: { 'X-Campaign': 'spring' },
      tags: ['invoice'],
    })
  })

  it('omits empty fields', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage(minimalMessage)
    expect(bodyOf(fetchMock)).toStrictEqual({
      sender: { email: 'noreply@example.com', name: 'Example' },
      to: [{ email: 'a@example.com' }],
      subject: 'Hi',
      textContent: 'Hi',
    })
  })

  it('leaves out empty versions', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage({
      ...minimalMessage,
      text: undefined,
      html: '<img src="x">',
    })
    await mailer.sendMessage({ ...minimalMessage, html: '' })
    expect(bodyOf(fetchMock, 0)).not.toHaveProperty('textContent')
    expect(bodyOf(fetchMock, 1)).not.toHaveProperty('htmlContent')
  })

  it('returns no message ID without one in the response', async () => {
    const { mailer } = setup(() => new Response(null, { status: 201 }))
    expect(await mailer.sendMessage(minimalMessage)).toEqual({
      messageId: undefined,
    })
  })

  it('accepts names of 70 characters and attachments in upper case', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage({
      ...minimalMessage,
      to: { name: 'x'.repeat(70), address: 'a@example.com' },
      attachments: [{ filename: 'REPORT.PDF', content: 'x' }],
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'several reply-to addresses',
      { replyTo: ['a@example.com', 'b@example.com'] },
      'Brevo accepts a single reply-to address, got 2.',
    ],
    [
      'an inline attachment',
      {
        attachments: [
          {
            filename: 'logo.png',
            content: new Uint8Array([9]),
            contentId: 'logo',
          },
        ],
      },
      'Brevo does not support inline attachments (logo.png has a contentId).',
    ],
    [
      'a long name',
      { cc: { name: 'x'.repeat(71), address: 'cc@example.com' } },
      `Brevo accepts names of at most 70 characters: "${'x'.repeat(20)}…" (cc@example.com).`,
    ],
    [
      'a long sender name',
      { from: { name: 'x'.repeat(71), address: 'noreply@example.com' } },
      `Brevo accepts names of at most 70 characters: "${'x'.repeat(20)}…" (noreply@example.com).`,
    ],
    [
      'an attachment type that Brevo refuses',
      { attachments: [{ filename: 'setup.exe', content: 'x' }] },
      'Brevo does not accept this attachment type: setup.exe (see the extensions accepted by Brevo).',
    ],
    [
      'an attachment without extension',
      { attachments: [{ filename: 'README', content: 'x' }] },
      'Brevo does not accept this attachment type: README (see the extensions accepted by Brevo).',
    ],
  ])('rejects %s', async (_, extra, text) => {
    const { fetchMock, mailer } = setup()
    await expect(
      mailer.sendMessage({ ...minimalMessage, ...extra } as MessageOptions)
    ).rejects.toThrow(new MailMessageError(text))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      'an API error',
      () =>
        json(400, {
          code: 'invalid_parameter',
          message: 'email is not valid in to',
        }),
      400,
      '400 invalid_parameter: email is not valid in to',
    ],
    [
      'an error without code',
      () => json(401, { message: 'Key not found' }, 'Unauthorized'),
      401,
      '401 Key not found',
    ],
    [
      'an error without body',
      () =>
        new Response(null, { status: 429, statusText: 'Too Many Requests' }),
      429,
      '429 Too Many Requests',
    ],
  ])('reports %s', async (_, response, status, text) => {
    const { mailer } = setup(response)
    const error = await mailer
      .sendMessage(minimalMessage)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toMatchObject({
      message: `Mail not sent by the brevo provider: ${text}`,
      provider: 'brevo',
      status,
    })
  })

  it.each([
    [
      'no API key',
      {},
      'createBrevoProvider(): apiKey must be a non-empty string.',
    ],
    [
      'an unknown option',
      { apiKey: 'k', region: 'eu' },
      'createBrevoProvider(): unknown option "region".',
    ],
  ])('rejects %s', (_, options, text) => {
    expect(() => createBrevoProvider(options as never)).toThrow(
      new TypeError(text)
    )
  })
})

describe('Brevo provider with the global fetch', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>

  beforeAll(async () => {
    server = await startHttpServer(({ body }): Reply =>
      body.includes('rejected@example.com')
        ? {
            status: 400,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              code: 'invalid_parameter',
              message: 'Invalid email address',
            }),
          }
        : {
            status: 201,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageId: '<brevo-1@relay.example.com>' }),
          }
    )
  })

  afterAll(() => server.close())

  const mailer = () =>
    createMailer({
      provider: createBrevoProvider({
        apiKey: 'xkeysib-1',
        baseUrl: server.url,
      }),
      from: 'noreply@example.com',
    })

  it('sends the request over HTTP', async () => {
    expect(await mailer().sendMessage(fullMessage)).toEqual({
      messageId: '<brevo-1@relay.example.com>',
    })
    const request = server.requests.at(-1)!
    expect(request.url).toBe('/v3/smtp/email')
    expect(request.headers['api-key']).toBe('xkeysib-1')
    expect(JSON.parse(request.body)).toMatchObject({ tags: ['invoice'] })
  })

  it('reports API errors', async () => {
    await expect(
      mailer().sendMessage({ ...minimalMessage, to: 'rejected@example.com' })
    ).rejects.toMatchObject({
      message:
        'Mail not sent by the brevo provider: 400 invalid_parameter: Invalid email address',
      status: 400,
    })
  })
})
