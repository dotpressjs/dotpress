import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createMailer,
  MailMessageError,
  MailSendError,
  type MessageOptions,
} from '../src/index.js'
import { createMailgunProvider } from '../src/providers/mailgun.js'
import { fullMessage, json, minimalMessage, mockFetch } from './fetch-mock.js'
import { startHttpServer, type Reply } from './http-server.js'

const queued = () =>
  json(200, {
    id: '<20261110.1@mg.example.com>',
    message: 'Queued. Thank you.',
  })

const setup = (response: () => Response = queued) => {
  const fetchMock = mockFetch(response)
  const mailer = createMailer({
    provider: createMailgunProvider({
      apiKey: 'key-1',
      domain: 'mg.example.com',
      fetch: fetchMock,
    }),
    from: 'Example <noreply@example.com>',
  })
  return { fetchMock, mailer }
}

/** Fields of a form, files as { name, type, bytes }. */
const fieldsOf = async (form: FormData) => {
  const fields: [string, unknown][] = []
  for (const [name, value] of form.entries()) {
    fields.push([
      name,
      typeof value === 'string'
        ? value
        : {
            name: value.name,
            type: value.type,
            bytes: [...new Uint8Array(await value.arrayBuffer())],
          },
    ])
  }
  return fields
}

const formOf = (fetchMock: ReturnType<typeof mockFetch>, call = 0) =>
  fetchMock.mock.calls[call]?.[1]?.body as FormData

describe('Mailgun provider', () => {
  it('posts the message as form data', async () => {
    const { fetchMock, mailer } = setup()
    const result = await mailer.sendMessage({
      ...fullMessage,
      to: ['"Lovelace, Ada" <ada@example.com>', 'grace@example.com'],
      replyTo: ['support@example.com', 'Sales <sales@example.com>'],
      tags: ['invoice', 'billing'],
      attachments: [
        ...(fullMessage.attachments ?? []),
        {
          filename: 'logo.png',
          content: new Uint8Array([9]),
          contentId: 'logo',
        },
      ],
    })
    expect(result).toEqual({ messageId: '<20261110.1@mg.example.com>' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.mailgun.net/v3/mg.example.com/messages')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('api:key-1').toString('base64')}`,
      },
    })
    // fetch sets the multipart content type, with its boundary.
    expect(init?.headers).not.toHaveProperty('content-type')
    expect(await fieldsOf(formOf(fetchMock))).toStrictEqual([
      ['from', '"Example" <noreply@example.com>'],
      ['to', '"Lovelace, Ada" <ada@example.com>'],
      ['to', 'grace@example.com'],
      ['cc', '"Charles" <charles@example.com>'],
      ['bcc', 'archive@example.com'],
      ['subject', 'Your invoice'],
      ['text', 'Hello'],
      ['html', '<p>Hello</p>'],
      ['h:Reply-To', 'support@example.com, "Sales" <sales@example.com>'],
      ['h:X-Campaign', 'spring'],
      ['o:tag', 'invoice'],
      ['o:tag', 'billing'],
      ['v:invoiceId', 'F-2026-001'],
      [
        'attachment',
        { name: 'invoice.pdf', type: 'application/pdf', bytes: [1, 2, 3] },
      ],
      [
        'attachment',
        {
          name: 'notes.txt',
          type: '',
          bytes: [...Buffer.from('Notes é')],
        },
      ],
      ['inline', { name: 'logo', type: '', bytes: [9] }],
    ])
  })

  it('sends the required fields only', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage(minimalMessage)
    expect(await fieldsOf(formOf(fetchMock))).toStrictEqual([
      ['from', '"Example" <noreply@example.com>'],
      ['to', 'a@example.com'],
      ['subject', 'Hi'],
      ['text', 'Hi'],
    ])
  })

  it('leaves out empty versions', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage({
      ...minimalMessage,
      text: undefined,
      html: '<img src="x">',
    })
    await mailer.sendMessage({ ...minimalMessage, html: '' })
    expect(formOf(fetchMock, 0).has('text')).toBe(false)
    expect(formOf(fetchMock, 0).get('html')).toBe('<img src="x">')
    expect(formOf(fetchMock, 1).has('html')).toBe(false)
  })

  it('encodes the domain in the URL, and uses the base URL', async () => {
    const fetchMock = mockFetch(queued)
    await createMailer({
      provider: createMailgunProvider({
        apiKey: 'key-1',
        domain: 'mg.example.com/x',
        baseUrl: 'https://api.eu.mailgun.net/',
        fetch: fetchMock,
      }),
      from: 'noreply@example.com',
    }).sendMessage(minimalMessage)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.eu.mailgun.net/v3/mg.example.com%2Fx/messages'
    )
  })

  it('returns no message ID without one in the response', async () => {
    const { mailer } = setup(() => json(200, { message: 'Queued.' }))
    expect(await mailer.sendMessage(minimalMessage)).toEqual({
      messageId: undefined,
    })
  })

  it('accepts 16 KB of options', async () => {
    const { fetchMock, mailer } = setup()
    // "v:a" (3 bytes) + 16,381 bytes.
    await mailer.sendMessage({
      ...minimalMessage,
      metadata: { a: 'x'.repeat(16_381) },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'more than 16 KB of metadata',
      { metadata: { a: 'x'.repeat(16_382) } },
      16_385,
    ],
    [
      'more than 16 KB of headers, tags and metadata (bytes)',
      {
        headers: { 'X-Note': 'é'.repeat(4_000) },
        tags: ['t'.repeat(256)],
        metadata: { a: 'x'.repeat(8_100) },
        replyTo: 'support@example.com',
      },
      8_008 + 261 + 8_103 + 10 + 19,
    ],
  ])('rejects %s', async (_, extra, size) => {
    const { fetchMock, mailer } = setup()
    await expect(
      mailer.sendMessage({ ...minimalMessage, ...extra } as MessageOptions)
    ).rejects.toThrow(
      new MailMessageError(
        `Mailgun accepts at most 16384 bytes of headers, tags and metadata, got ${size}.`
      )
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      'an API error',
      () => json(400, { message: "'to' parameter is not a valid address." }),
      400,
      "400 'to' parameter is not a valid address.",
    ],
    [
      'an error without body',
      () => new Response(null, { status: 401, statusText: 'Unauthorized' }),
      401,
      '401 Unauthorized',
    ],
  ])('reports %s', async (_, response, status, text) => {
    const { mailer } = setup(response)
    const error = await mailer
      .sendMessage(minimalMessage)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toMatchObject({
      message: `Mail not sent by the mailgun provider: ${text}`,
      provider: 'mailgun',
      status,
    })
  })

  it.each([
    [
      'no domain',
      { apiKey: 'key-1' },
      'createMailgunProvider(): domain must be a non-empty string.',
    ],
    [
      'no API key',
      { domain: 'mg.example.com' },
      'createMailgunProvider(): apiKey must be a non-empty string.',
    ],
  ])('rejects %s', (_, options, text) => {
    expect(() => createMailgunProvider(options as never)).toThrow(
      new TypeError(text)
    )
  })
})

describe('Mailgun provider with the global fetch', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>

  beforeAll(async () => {
    server = await startHttpServer(({ body }): Reply =>
      body.includes('rejected@example.com')
        ? {
            status: 400,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'Invalid recipient.' }),
          }
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: '<server-1@mg.example.com>',
              message: 'Queued.',
            }),
          }
    )
  })

  afterAll(() => server.close())

  const mailer = () =>
    createMailer({
      provider: createMailgunProvider({
        apiKey: 'key-1',
        domain: 'mg.example.com',
        baseUrl: server.url,
      }),
      from: 'noreply@example.com',
    })

  it('sends a multipart request over HTTP', async () => {
    expect(
      await mailer().sendMessage({
        ...fullMessage,
        attachments: [
          {
            filename: 'invoice.pdf',
            content: new Uint8Array([0, 255, 1]),
            contentType: 'application/pdf',
          },
        ],
      })
    ).toEqual({ messageId: '<server-1@mg.example.com>' })

    const request = server.requests.at(-1)!
    expect(request.url).toBe('/v3/mg.example.com/messages')
    expect(request.headers['content-type']).toMatch(
      /^multipart\/form-data; boundary=/
    )
    const form = await new Response(new Uint8Array(request.raw), {
      headers: { 'content-type': request.headers['content-type']! },
    }).formData()
    expect(form.getAll('to')).toEqual([
      '"Ada Lovelace" <ada@example.com>',
      'grace@example.com',
    ])
    expect(form.get('o:tag')).toBe('invoice')
    const file = form.get('attachment') as File
    expect(file.name).toBe('invoice.pdf')
    expect(file.type).toBe('application/pdf')
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 255, 1])
  })

  it('reports API errors', async () => {
    await expect(
      mailer().sendMessage({ ...minimalMessage, to: 'rejected@example.com' })
    ).rejects.toMatchObject({
      message: 'Mail not sent by the mailgun provider: 400 Invalid recipient.',
      status: 400,
    })
  })
})
