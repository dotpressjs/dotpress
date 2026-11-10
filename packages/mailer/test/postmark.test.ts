import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createMailer,
  MailMessageError,
  MailSendError,
  type MessageOptions,
} from '../src/index.js'
import { createPostmarkProvider } from '../src/providers/postmark.js'
import {
  bodyOf,
  fullMessage,
  json,
  largeAttachment,
  minimalMessage,
  mockFetch,
} from './fetch-mock.js'
import { startHttpServer, type Reply } from './http-server.js'

const sent = () =>
  json(200, {
    To: 'a@example.com',
    SubmittedAt: '2026-11-10T10:00:00Z',
    MessageID: 'pm-1',
    ErrorCode: 0,
    Message: 'OK',
  })

const setup = (
  response: () => Response = sent,
  options: { messageStream?: string } = {}
) => {
  const fetchMock = mockFetch(response)
  const mailer = createMailer({
    provider: createPostmarkProvider({
      serverToken: 'server-token',
      fetch: fetchMock,
      ...options,
    }),
    from: 'Example <noreply@example.com>',
  })
  return { fetchMock, mailer }
}

describe('Postmark provider', () => {
  it('posts the message to the Email API', async () => {
    const { fetchMock, mailer } = setup(sent, { messageStream: 'outbound' })
    const result = await mailer.sendMessage({
      ...fullMessage,
      replyTo: ['support@example.com', 'Sales <sales@example.com>'],
      attachments: [
        ...(fullMessage.attachments ?? []),
        {
          filename: 'logo.png',
          content: new Uint8Array([9]),
          contentId: 'logo',
        },
      ],
    })
    expect(result).toEqual({ messageId: 'pm-1' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.postmarkapp.com/email')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-postmark-server-token': 'server-token',
      },
    })
    expect(bodyOf(fetchMock)).toStrictEqual({
      From: '"Example" <noreply@example.com>',
      To: '"Ada Lovelace" <ada@example.com>, grace@example.com',
      Cc: '"Charles" <charles@example.com>',
      Bcc: 'archive@example.com',
      ReplyTo: 'support@example.com, "Sales" <sales@example.com>',
      Subject: 'Your invoice',
      TextBody: 'Hello',
      HtmlBody: '<p>Hello</p>',
      Headers: [{ Name: 'X-Campaign', Value: 'spring' }],
      Attachments: [
        {
          Name: 'invoice.pdf',
          Content: 'AQID',
          ContentType: 'application/pdf',
        },
        {
          Name: 'notes.txt',
          Content: 'Tm90ZXMgw6k=',
          ContentType: 'application/octet-stream',
        },
        {
          Name: 'logo.png',
          Content: 'CQ==',
          ContentType: 'application/octet-stream',
          ContentID: 'cid:logo',
        },
      ],
      Tag: 'invoice',
      Metadata: { invoiceId: 'F-2026-001' },
      MessageStream: 'outbound',
    })
  })

  it('omits empty fields', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage(minimalMessage)
    expect(bodyOf(fetchMock)).toStrictEqual({
      From: '"Example" <noreply@example.com>',
      To: 'a@example.com',
      Subject: 'Hi',
      TextBody: 'Hi',
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
    expect(bodyOf(fetchMock, 0)).not.toHaveProperty('TextBody')
    expect(bodyOf(fetchMock, 0).HtmlBody).toBe('<img src="x">')
    expect(bodyOf(fetchMock, 1)).not.toHaveProperty('HtmlBody')
  })

  it('returns no message ID without one in the response', async () => {
    const { mailer } = setup(() => json(200, { ErrorCode: 0 }))
    expect(await mailer.sendMessage(minimalMessage)).toEqual({
      messageId: undefined,
    })
  })

  it('accepts the limits', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage({
      ...minimalMessage,
      to: Array.from({ length: 48 }, (_, index) => `to${index}@example.com`),
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      subject: 'x'.repeat(2000),
      attachments: [{ filename: 'archive.zip', content: 'x' }],
      replyTo: `${'a'.repeat(242)}@example.com`,
      // "x…x" <noreply@example.com>: 255 characters.
      from: { name: 'x'.repeat(231), address: 'noreply@example.com' },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'more than 50 recipients',
      {
        to: Array.from({ length: 49 }, (_, index) => `to${index}@example.com`),
        cc: 'cc@example.com',
        bcc: 'bcc@example.com',
      },
      'Postmark accepts at most 50 recipients (to, cc and bcc), got 51.',
    ],
    [
      'a long address',
      { replyTo: `${'a'.repeat(243)}@example.com` },
      `Postmark accepts addresses of at most 254 characters: ${'a'.repeat(20)}… has 255.`,
    ],
    [
      'a long sender',
      { from: { name: 'x'.repeat(240), address: 'noreply@example.com' } },
      'Postmark accepts a sender of at most 255 characters.',
    ],
    [
      'a long subject',
      { subject: 'x'.repeat(2001) },
      'Postmark accepts subjects of at most 2000 characters, got 2001.',
    ],
    ['two tags', { tags: ['a', 'b'] }, 'Postmark accepts a single tag, got 2.'],
    [
      'a forbidden attachment',
      { attachments: [{ filename: 'SETUP.EXE', content: 'x' }] },
      'Postmark does not accept .exe attachments (SETUP.EXE).',
    ],
    [
      'a request over 10 MB',
      { attachments: [largeAttachment(7_600_000)] },
      'Postmark accepts requests of at most 10 MB, got 10.1 MB (attachments are base64-encoded).',
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
      'a validation error',
      () => json(422, { ErrorCode: 300, Message: 'Invalid email request' }),
      422,
      '422 Invalid email request (ErrorCode 300)',
    ],
    [
      'an error without code',
      () => json(401, { Message: 'Bad token' }, 'Unauthorized'),
      401,
      '401 Bad token',
    ],
    [
      'an error without body',
      () =>
        new Response(null, {
          status: 500,
          statusText: 'Internal Server Error',
        }),
      500,
      '500 Internal Server Error',
    ],
  ])('reports %s', async (_, response, status, text) => {
    const { mailer } = setup(response)
    const error = await mailer
      .sendMessage(minimalMessage)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toMatchObject({
      message: `Mail not sent by the postmark provider: ${text}`,
      provider: 'postmark',
      status,
    })
  })

  it.each([
    [
      'no server token',
      {},
      'createPostmarkProvider(): serverToken must be a non-empty string.',
    ],
    [
      'an unknown option',
      { serverToken: 't', token: 't' },
      'createPostmarkProvider(): unknown option "token".',
    ],
    [
      'an empty message stream',
      { serverToken: 't', messageStream: '' },
      'createPostmarkProvider(): messageStream must be a non-empty string.',
    ],
    [
      'a message stream that is not a string',
      { serverToken: 't', messageStream: 1 },
      'createPostmarkProvider(): messageStream must be a non-empty string.',
    ],
    [
      'an invalid base URL',
      { serverToken: 't', baseUrl: 'api.postmarkapp.com' },
      'createPostmarkProvider(): baseUrl must be an http(s) URL.',
    ],
    [
      'a fetch that is not a function',
      { serverToken: 't', fetch: 1 },
      'createPostmarkProvider(): fetch must be a function.',
    ],
  ])('rejects %s', (_, options, text) => {
    expect(() => createPostmarkProvider(options as never)).toThrow(
      new TypeError(text)
    )
  })
})

describe('Postmark provider with the global fetch', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>

  beforeAll(async () => {
    server = await startHttpServer(({ body }): Reply =>
      body.includes('rejected@example.com')
        ? {
            status: 422,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ErrorCode: 406,
              Message:
                'You tried to send to recipient(s) that have been marked as inactive.',
            }),
          }
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ MessageID: 'pm-server-1', ErrorCode: 0 }),
          }
    )
  })

  afterAll(() => server.close())

  const mailer = () =>
    createMailer({
      provider: createPostmarkProvider({
        serverToken: 'server-token',
        baseUrl: `${server.url}/`,
      }),
      from: 'noreply@example.com',
    })

  it('sends the request over HTTP', async () => {
    expect(await mailer().sendMessage(fullMessage)).toEqual({
      messageId: 'pm-server-1',
    })
    const request = server.requests.at(-1)!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/email')
    expect(request.headers['x-postmark-server-token']).toBe('server-token')
    expect(request.headers.accept).toBe('application/json')
    expect(JSON.parse(request.body)).toMatchObject({ Tag: 'invoice' })
  })

  it('reports API errors', async () => {
    await expect(
      mailer().sendMessage({ ...minimalMessage, to: 'rejected@example.com' })
    ).rejects.toMatchObject({
      message:
        'Mail not sent by the postmark provider: 422 You tried to send to recipient(s) that have been marked as inactive. (ErrorCode 406)',
      status: 422,
    })
  })
})
