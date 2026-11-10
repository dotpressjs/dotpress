import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createMailer,
  MailMessageError,
  MailSendError,
  type MessageOptions,
} from '../src/index.js'
import { createMailjetProvider } from '../src/providers/mailjet.js'
import {
  bodyOf,
  fullMessage,
  json,
  largeAttachment,
  minimalMessage,
  mockFetch,
} from './fetch-mock.js'
import { startHttpServer, type Reply } from './http-server.js'

const success = (
  to: unknown[] = [
    { Email: 'a@example.com', MessageUUID: 'uuid-1', MessageID: 1001 },
  ]
) => json(201, { Messages: [{ Status: 'success', To: to }] })

const setup = (response: () => Response = () => success()) => {
  const fetchMock = mockFetch(response)
  const mailer = createMailer({
    provider: createMailjetProvider({
      apiKey: 'public',
      apiSecret: 'private',
      fetch: fetchMock,
    }),
    from: 'Example <noreply@example.com>',
  })
  return { fetchMock, mailer }
}

describe('Mailjet provider', () => {
  it('posts the message to the Send API v3.1', async () => {
    const { fetchMock, mailer } = setup()
    const result = await mailer.sendMessage({
      ...fullMessage,
      attachments: [
        ...(fullMessage.attachments ?? []),
        {
          filename: 'logo.png',
          content: new Uint8Array([9]),
          contentId: 'logo',
        },
      ],
    })
    expect(result).toEqual({ messageId: 'uuid-1' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.mailjet.com/v3.1/send')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('public:private').toString('base64')}`,
        'content-type': 'application/json',
      },
    })
    // Mailjet has no tags: they are ignored.
    expect(bodyOf(fetchMock)).toStrictEqual({
      Messages: [
        {
          From: { Email: 'noreply@example.com', Name: 'Example' },
          To: [
            { Email: 'ada@example.com', Name: 'Ada Lovelace' },
            { Email: 'grace@example.com' },
          ],
          Cc: [{ Email: 'charles@example.com', Name: 'Charles' }],
          Bcc: [{ Email: 'archive@example.com' }],
          ReplyTo: { Email: 'support@example.com', Name: 'Support' },
          Subject: 'Your invoice',
          TextPart: 'Hello',
          HTMLPart: '<p>Hello</p>',
          Headers: { 'X-Campaign': 'spring' },
          Attachments: [
            {
              ContentType: 'application/pdf',
              Filename: 'invoice.pdf',
              Base64Content: 'AQID',
            },
            {
              ContentType: 'application/octet-stream',
              Filename: 'notes.txt',
              Base64Content: 'Tm90ZXMgw6k=',
            },
          ],
          InlinedAttachments: [
            {
              ContentType: 'application/octet-stream',
              Filename: 'logo.png',
              Base64Content: 'CQ==',
              ContentID: 'logo',
            },
          ],
          EventPayload: '{"invoiceId":"F-2026-001"}',
        },
      ],
    })
  })

  it('omits empty fields', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage(minimalMessage)
    expect(bodyOf(fetchMock)).toStrictEqual({
      Messages: [
        {
          From: { Email: 'noreply@example.com', Name: 'Example' },
          To: [{ Email: 'a@example.com' }],
          Subject: 'Hi',
          TextPart: 'Hi',
        },
      ],
    })
  })

  it('sends inline attachments only', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage({
      ...minimalMessage,
      attachments: [{ filename: 'logo.png', content: 'x', contentId: 'logo' }],
    })
    const [message] = bodyOf(fetchMock).Messages as Record<string, unknown>[]
    expect(message).not.toHaveProperty('Attachments')
    expect(message?.InlinedAttachments).toHaveLength(1)
  })

  it('leaves out empty versions', async () => {
    const { fetchMock, mailer } = setup()
    await mailer.sendMessage({
      ...minimalMessage,
      text: undefined,
      html: '<img src="x">',
    })
    await mailer.sendMessage({ ...minimalMessage, html: '' })
    const first = (bodyOf(fetchMock, 0).Messages as object[])[0]
    const second = (bodyOf(fetchMock, 1).Messages as object[])[0]
    expect(first).not.toHaveProperty('TextPart')
    expect(second).not.toHaveProperty('HTMLPart')
  })

  it.each([
    [
      'the UUID of the first recipient',
      [
        { Email: 'a@example.com', MessageUUID: 'uuid-a', MessageID: 1 },
        { Email: 'b@example.com', MessageUUID: 'uuid-b', MessageID: 2 },
      ],
      'uuid-a',
    ],
    ['the numeric ID', [{ Email: 'a@example.com', MessageID: 456 }], '456'],
    ['nothing (sandbox mode)', [{ Email: 'a@example.com' }], undefined],
    ['nothing without recipients', [], undefined],
  ])('returns %s', async (_, to, messageId) => {
    const { mailer } = setup(() => success(to))
    expect(await mailer.sendMessage(minimalMessage)).toEqual({ messageId })
  })

  it('returns no message ID without body', async () => {
    const { mailer } = setup(() => new Response(null, { status: 201 }))
    expect(await mailer.sendMessage(minimalMessage)).toEqual({
      messageId: undefined,
    })
  })

  it.each([
    [
      'several reply-to addresses',
      { replyTo: ['a@example.com', 'b@example.com'] },
      'Mailjet accepts a single reply-to address, got 2.',
    ],
    [
      'a request over 15 MB',
      { attachments: [largeAttachment(11_300_000)] },
      'Mailjet accepts requests of at most 15 MB, got 15.1 MB (attachments are base64-encoded).',
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
      'message errors',
      () =>
        json(400, {
          Messages: [
            {
              Status: 'error',
              Errors: [
                {
                  ErrorCode: 'mj-0013',
                  StatusCode: 400,
                  ErrorMessage: '"to" is an invalid email address.',
                },
                {
                  ErrorCode: 'mj-0004',
                  StatusCode: 400,
                  ErrorMessage: 'Type mismatch.',
                },
              ],
            },
          ],
        }),
      400,
      '400 "to" is an invalid email address.; Type mismatch.',
    ],
    [
      'a top-level error',
      () =>
        json(401, {
          ErrorMessage: 'API key authentication/authorization failure.',
          StatusCode: 401,
        }),
      401,
      '401 API key authentication/authorization failure.',
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
    [
      'a message error in a successful response',
      () =>
        json(201, {
          Messages: [
            {
              Status: 'error',
              Errors: [{ StatusCode: 400, ErrorMessage: 'Blocked recipient.' }],
            },
          ],
        }),
      400,
      '400 Blocked recipient.',
    ],
    [
      'a status code that is not a number',
      () =>
        json(201, {
          Messages: [
            {
              Status: 'error',
              Errors: [{ StatusCode: '400', ErrorMessage: 'Rejected.' }],
            },
          ],
        }),
      undefined,
      'Rejected.',
    ],
    [
      'errors without messages',
      () =>
        json(
          400,
          { Messages: [{ Status: 'error', Errors: [{ StatusCode: 400 }] }] },
          'Bad Request'
        ),
      400,
      '400 Bad Request',
    ],
    [
      'a message error without details',
      () => json(201, { Messages: [{ Status: 'error' }] }),
      undefined,
      'message rejected',
    ],
  ])('reports %s', async (_, response, status, text) => {
    const { mailer } = setup(response)
    const error = await mailer
      .sendMessage(minimalMessage)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toMatchObject({
      message: `Mail not sent by the mailjet provider: ${text}`,
      provider: 'mailjet',
      status,
    })
  })

  it.each([
    [
      'no API secret',
      { apiKey: 'public' },
      'createMailjetProvider(): apiSecret must be a non-empty string.',
    ],
    [
      'no API key',
      { apiSecret: 'private' },
      'createMailjetProvider(): apiKey must be a non-empty string.',
    ],
  ])('rejects %s', (_, options, text) => {
    expect(() => createMailjetProvider(options as never)).toThrow(
      new TypeError(text)
    )
  })
})

describe('Mailjet provider with the global fetch', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>

  beforeAll(async () => {
    server = await startHttpServer(({ body }): Reply =>
      body.includes('rejected@example.com')
        ? {
            status: 400,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              Messages: [
                {
                  Status: 'error',
                  Errors: [
                    { StatusCode: 400, ErrorMessage: 'Invalid recipient.' },
                  ],
                },
              ],
            }),
          }
        : {
            status: 201,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              Messages: [
                {
                  Status: 'success',
                  To: [{ Email: 'a@example.com', MessageUUID: 'uuid-server' }],
                },
              ],
            }),
          }
    )
  })

  afterAll(() => server.close())

  const mailer = () =>
    createMailer({
      provider: createMailjetProvider({
        apiKey: 'public',
        apiSecret: 'private',
        baseUrl: server.url,
      }),
      from: 'noreply@example.com',
    })

  it('sends the request over HTTP', async () => {
    expect(await mailer().sendMessage(fullMessage)).toEqual({
      messageId: 'uuid-server',
    })
    const request = server.requests.at(-1)!
    expect(request.url).toBe('/v3.1/send')
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from('public:private').toString('base64')}`
    )
  })

  it('reports API errors', async () => {
    await expect(
      mailer().sendMessage({ ...minimalMessage, to: 'rejected@example.com' })
    ).rejects.toMatchObject({
      message: 'Mail not sent by the mailjet provider: 400 Invalid recipient.',
      status: 400,
    })
  })
})
