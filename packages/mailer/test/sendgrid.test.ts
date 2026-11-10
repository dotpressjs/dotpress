import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createMailer,
  MailMessageError,
  MailSendError,
  type MessageOptions,
} from '../src/index.js'
import { createSendgridProvider } from '../src/providers/sendgrid.js'
import { startHttpServer, type Reply } from './http-server.js'

const message: MessageOptions = {
  to: ['Ada Lovelace <ada@example.com>', 'grace@example.com'],
  cc: 'Charles <charles@example.com>',
  bcc: ['archive@example.com'],
  replyTo: 'Support <support@example.com>',
  subject: 'Your invoice',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [
    {
      filename: 'invoice.pdf',
      content: new Uint8Array([1, 2, 3]),
      contentType: 'application/pdf',
    },
    { filename: 'notes.txt', content: 'Notes é' },
    { filename: 'logo.png', content: new Uint8Array([9]), contentId: 'logo' },
  ],
  headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' },
}

const minimal: MessageOptions = {
  to: 'a@example.com',
  subject: 'Hi',
  text: 'Hi',
}

const accepted = () =>
  new Response(null, { status: 202, headers: { 'x-message-id': 'sg-1' } })

const mockFetch = (response: () => Response = accepted) =>
  vi.fn<typeof fetch>(async () => response())

const mailerWith = (provider: ReturnType<typeof createSendgridProvider>) =>
  createMailer({ provider, from: 'Example <noreply@example.com>' })

/** JSON body of the n-th call of a fetch mock. */
const bodyOf = (fetchMock: ReturnType<typeof mockFetch>, call = 0) =>
  JSON.parse(fetchMock.mock.calls[call]?.[1]?.body as string) as unknown

describe('SendGrid provider', () => {
  it('posts the message to the Mail Send API', async () => {
    const fetchMock = mockFetch()
    const provider = createSendgridProvider({
      apiKey: 'SG.key',
      fetch: fetchMock,
    })
    expect(provider.name).toBe('sendgrid')

    expect(await mailerWith(provider).sendMessage(message)).toEqual({
      messageId: 'sg-1',
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer SG.key',
        'content-type': 'application/json',
      },
    })
    expect(bodyOf(fetchMock)).toStrictEqual({
      personalizations: [
        {
          to: [
            { email: 'ada@example.com', name: 'Ada Lovelace' },
            { email: 'grace@example.com' },
          ],
          cc: [{ email: 'charles@example.com', name: 'Charles' }],
          bcc: [{ email: 'archive@example.com' }],
        },
      ],
      from: { email: 'noreply@example.com', name: 'Example' },
      reply_to: { email: 'support@example.com', name: 'Support' },
      subject: 'Your invoice',
      content: [
        { type: 'text/plain', value: 'Hello' },
        { type: 'text/html', value: '<p>Hello</p>' },
      ],
      attachments: [
        {
          content: 'AQID',
          filename: 'invoice.pdf',
          type: 'application/pdf',
          disposition: 'attachment',
        },
        {
          content: 'Tm90ZXMgw6k=',
          filename: 'notes.txt',
          disposition: 'attachment',
        },
        {
          content: 'CQ==',
          filename: 'logo.png',
          disposition: 'inline',
          content_id: 'logo',
        },
      ],
      headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' },
    })
  })

  it('omits empty fields', async () => {
    const fetchMock = mockFetch()
    await mailerWith(
      createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
    ).sendMessage(minimal)
    expect(bodyOf(fetchMock)).toStrictEqual({
      personalizations: [{ to: [{ email: 'a@example.com' }] }],
      from: { email: 'noreply@example.com', name: 'Example' },
      subject: 'Hi',
      content: [{ type: 'text/plain', value: 'Hi' }],
    })
  })

  it('sends tags as categories and metadata as custom_args', async () => {
    const fetchMock = mockFetch()
    await mailerWith(
      createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
    ).sendMessage({
      ...minimal,
      tags: Array.from({ length: 10 }, (_, index) => `tag-${index}`),
      metadata: { userId: '42', email: 'ada@example.com' },
    })
    const body = bodyOf(fetchMock) as {
      categories: unknown
      personalizations: { custom_args: unknown }[]
    }
    expect(body.categories).toHaveLength(10)
    expect(body.categories).toContain('tag-9')
    expect(body.personalizations[0]?.custom_args).toStrictEqual({
      userId: '42',
      email: 'ada@example.com',
    })
  })

  it.each([
    [
      { tags: Array.from({ length: 11 }, (_, index) => `t${index}`) },
      'SendGrid accepts at most 10 tags (categories), got 11.',
    ],
    [
      { tags: ['ok', 'x'.repeat(256)] },
      `SendGrid accepts tags (categories) of at most 255 characters: "${'x'.repeat(20)}…" has 256.`,
    ],
    [
      { metadata: { a: 'x'.repeat(9_993) } },
      'SendGrid accepts at most 10000 bytes of metadata (custom_args), got 10001.',
    ],
    [
      // Bytes, not characters: é takes 2 bytes in UTF-8.
      { metadata: { a: 'é'.repeat(4_997) } },
      'SendGrid accepts at most 10000 bytes of metadata (custom_args), got 10002.',
    ],
  ])('rejects %#', async (extra, text) => {
    const fetchMock = mockFetch()
    await expect(
      mailerWith(
        createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
      ).sendMessage({ ...minimal, ...extra })
    ).rejects.toThrow(new MailMessageError(text))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts tags of 255 characters', async () => {
    const fetchMock = mockFetch()
    await mailerWith(
      createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
    ).sendMessage({ ...minimal, tags: ['x'.repeat(255)] })
    expect((bodyOf(fetchMock) as { categories: unknown }).categories).toEqual([
      'x'.repeat(255),
    ])
  })

  it('accepts 10000 bytes of metadata', async () => {
    const fetchMock = mockFetch()
    await mailerWith(
      createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
    ).sendMessage({ ...minimal, metadata: { a: 'x'.repeat(9_992) } })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('uses reply_to_list for several reply-to addresses', async () => {
    const fetchMock = mockFetch()
    await mailerWith(
      createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
    ).sendMessage({
      ...minimal,
      replyTo: ['a@example.com', 'B <b@example.com>'],
    })
    const body = bodyOf(fetchMock) as Record<string, unknown>
    expect(body.reply_to_list).toStrictEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com', name: 'B' },
    ])
    expect(body).not.toHaveProperty('reply_to')
  })

  it('leaves out empty versions', async () => {
    const fetchMock = mockFetch()
    const mailer = mailerWith(
      createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
    )
    // The text converted from an image-only HTML version is empty.
    await mailer.sendMessage({
      ...minimal,
      text: undefined,
      html: '<img src="x">',
    })
    await mailer.sendMessage({ ...minimal, html: '' })
    expect((bodyOf(fetchMock, 0) as { content: unknown }).content).toEqual([
      { type: 'text/html', value: '<img src="x">' },
    ])
    expect((bodyOf(fetchMock, 1) as { content: unknown }).content).toEqual([
      { type: 'text/plain', value: 'Hi' },
    ])
  })

  it('uses the base URL', async () => {
    const fetchMock = mockFetch()
    await mailerWith(
      createSendgridProvider({
        apiKey: 'SG.key',
        baseUrl: 'https://api.eu.sendgrid.com/',
        fetch: fetchMock,
      })
    ).sendMessage(minimal)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.eu.sendgrid.com/v3/mail/send'
    )
  })

  it('returns no message ID without the header', async () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 202 }))
    expect(
      await mailerWith(
        createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
      ).sendMessage(minimal)
    ).toEqual({ messageId: undefined })
  })

  it.each([
    [
      'the errors of the API',
      400,
      JSON.stringify({
        errors: [
          { message: 'Invalid from email address', field: 'from', help: null },
          {
            message: 'Does not contain a valid address.',
            field: 'personalizations.0.to.0.email',
          },
        ],
      }),
      '400 Invalid from email address; Does not contain a valid address.',
    ],
    ['a body that is not JSON', 502, 'Bad gateway', '502 Bad Gateway'],
    [
      'errors without messages',
      401,
      JSON.stringify({ errors: [{ field: null }, null, { message: '' }] }),
      '401 Unauthorized',
    ],
    ['a JSON body without errors', 500, '{}', '500 Internal Server Error'],
    ['an empty body', 413, '', '413 Payload Too Large'],
  ])('reports %s', async (_, status, body, text) => {
    const statusText = {
      400: 'Bad Request',
      401: 'Unauthorized',
      413: 'Payload Too Large',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
    }[status]
    const fetchMock = mockFetch(
      () => new Response(body || null, { status, statusText })
    )
    const error = await mailerWith(
      createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
    )
      .sendMessage(minimal)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toMatchObject({
      message: `Mail not sent by the sendgrid provider: ${text}`,
      provider: 'sendgrid',
      status,
    })
  })

  it('reports a status without status text', async () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 503 }))
    await expect(
      mailerWith(
        createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
      ).sendMessage(minimal)
    ).rejects.toMatchObject({
      message: 'Mail not sent by the sendgrid provider: 503',
    })
  })

  it('reports a response whose body cannot be read', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('connection reset'))
      },
    })
    const fetchMock = mockFetch(
      () =>
        new Response(body, { status: 500, statusText: 'Internal Server Error' })
    )
    await expect(
      mailerWith(
        createSendgridProvider({ apiKey: 'SG.key', fetch: fetchMock })
      ).sendMessage(minimal)
    ).rejects.toMatchObject({
      message:
        'Mail not sent by the sendgrid provider: 500 Internal Server Error',
      status: 500,
    })
  })

  it('reports network errors', async () => {
    const failure = new TypeError('fetch failed')
    const error = await mailerWith(
      createSendgridProvider({
        apiKey: 'SG.key',
        fetch: () => Promise.reject(failure),
      })
    )
      .sendMessage(minimal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({
      message: 'Mail not sent by the sendgrid provider: fetch failed',
      provider: 'sendgrid',
      cause: failure,
    })
  })

  it.each([
    [
      'no options',
      undefined,
      'createSendgridProvider(): expected an object of options.',
    ],
    [
      'an unknown option',
      { apiKey: 'SG.key', region: 'eu' },
      'createSendgridProvider(): unknown option "region".',
    ],
    [
      'no API key',
      {},
      'createSendgridProvider(): apiKey must be a non-empty string.',
    ],
    [
      'an empty API key',
      { apiKey: '' },
      'createSendgridProvider(): apiKey must be a non-empty string.',
    ],
    [
      'a base URL without scheme',
      { apiKey: 'SG.key', baseUrl: 'api.sendgrid.com' },
      'createSendgridProvider(): baseUrl must be an http(s) URL.',
    ],
    [
      'a base URL without host',
      { apiKey: 'SG.key', baseUrl: 'https:///v3' },
      'createSendgridProvider(): baseUrl must be an http(s) URL.',
    ],
    [
      'a base URL that is not a string',
      { apiKey: 'SG.key', baseUrl: 1 },
      'createSendgridProvider(): baseUrl must be an http(s) URL.',
    ],
    [
      'a fetch that is not a function',
      { apiKey: 'SG.key', fetch: {} },
      'createSendgridProvider(): fetch must be a function.',
    ],
  ])('rejects %s', (_, options, text) => {
    expect(() => createSendgridProvider(options as never)).toThrow(
      new TypeError(text)
    )
  })
})

describe('SendGrid provider with the global fetch', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>

  beforeAll(async () => {
    server = await startHttpServer(({ body }): Reply =>
      body.includes('rejected@example.com')
        ? {
            status: 400,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              errors: [{ message: 'The to address is invalid.', field: 'to' }],
            }),
          }
        : { status: 202, headers: { 'x-message-id': 'sg-message-1' } }
    )
  })

  afterAll(() => server.close())

  const provider = () =>
    createSendgridProvider({ apiKey: 'SG.key', baseUrl: server.url })

  it('sends the request over HTTP', async () => {
    expect(await mailerWith(provider()).sendMessage(message)).toEqual({
      messageId: 'sg-message-1',
    })
    const request = server.requests.at(-1)!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/v3/mail/send')
    expect(request.headers.authorization).toBe('Bearer SG.key')
    expect(request.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request.body)).toMatchObject({
      subject: 'Your invoice',
      personalizations: [{ bcc: [{ email: 'archive@example.com' }] }],
    })
  })

  it('reports API errors', async () => {
    await expect(
      mailerWith(provider()).sendMessage({
        ...minimal,
        to: 'rejected@example.com',
      })
    ).rejects.toMatchObject({
      message:
        'Mail not sent by the sendgrid provider: 400 The to address is invalid.',
      status: 400,
    })
  })
})
