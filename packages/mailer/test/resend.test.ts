import type { CreateEmailOptions } from 'resend'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createMailer,
  MailSendError,
  type MessageOptions,
} from '../src/index.js'
import {
  createResendProvider,
  type ResendClient,
} from '../src/providers/resend.js'
import { startHttpServer } from './http-server.js'

const message: MessageOptions = {
  to: ['Ada Lovelace <ada@example.com>', 'grace@example.com'],
  cc: 'Charles <charles@example.com>',
  bcc: ['archive@example.com'],
  replyTo: ['support@example.com', 'Sales <sales@example.com>'],
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

const mockClient = (
  response: Awaited<ReturnType<ResendClient['emails']['send']>> = {
    data: { id: 'resend-1' },
    error: null,
    headers: null,
  }
) => {
  const send = vi.fn<(payload: CreateEmailOptions) => Promise<typeof response>>(
    async () => response
  )
  return { client: { emails: { send } }, send }
}

const mailerWith = (provider: ReturnType<typeof createResendProvider>) =>
  createMailer({ provider, from: 'Example <noreply@example.com>' })

describe('Resend provider', () => {
  it('sends the message with the SDK', async () => {
    const { client, send } = mockClient()
    const provider = createResendProvider({ client })
    expect(provider.name).toBe('resend')

    expect(await mailerWith(provider).sendMessage(message)).toEqual({
      messageId: 'resend-1',
    })
    expect(send).toHaveBeenCalledExactlyOnceWith({
      from: '"Example" <noreply@example.com>',
      to: ['"Ada Lovelace" <ada@example.com>', 'grace@example.com'],
      cc: ['"Charles" <charles@example.com>'],
      bcc: ['archive@example.com'],
      replyTo: ['support@example.com', '"Sales" <sales@example.com>'],
      subject: 'Your invoice',
      text: 'Hello',
      html: '<p>Hello</p>',
      attachments: [
        {
          filename: 'invoice.pdf',
          content: 'AQID',
          contentType: 'application/pdf',
        },
        { filename: 'notes.txt', content: 'Tm90ZXMgw6k=' },
        { filename: 'logo.png', content: 'CQ==', contentId: 'logo' },
      ],
      headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' },
    })
  })

  it('omits empty fields', async () => {
    const { client, send } = mockClient()
    await mailerWith(createResendProvider({ client })).sendMessage(minimal)
    expect(send.mock.calls[0]?.[0]).toStrictEqual({
      from: '"Example" <noreply@example.com>',
      to: ['a@example.com'],
      subject: 'Hi',
      text: 'Hi',
    })
  })

  it('reports API errors with their status', async () => {
    const failure = {
      name: 'validation_error' as const,
      message: 'The `to` field must be a valid email address.',
      statusCode: 422,
    }
    const { client } = mockClient({ data: null, error: failure, headers: null })
    const error = await mailerWith(createResendProvider({ client }))
      .sendMessage(minimal)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toMatchObject({
      message:
        'Mail not sent by the resend provider: validation_error: The `to` field must be a valid email address.',
      provider: 'resend',
      status: 422,
      cause: failure,
    })

    const { client: noStatus } = mockClient({
      data: null,
      error: { ...failure, statusCode: null },
      headers: null,
    })
    await expect(
      mailerWith(createResendProvider({ client: noStatus })).sendMessage(
        minimal
      )
    ).rejects.toMatchObject({ status: undefined })
  })

  it.each([
    [
      'not an object',
      'key',
      'createResendProvider(): expected an object of options.',
    ],
    [
      'an unknown option',
      { key: 'x' },
      'createResendProvider(): unknown option "key".',
    ],
    [
      'a client with an API key',
      { client: mockClient().client, apiKey: 're_x' },
      'createResendProvider(): set client, or apiKey and baseUrl, not both.',
    ],
    [
      'a client with a base URL',
      { client: mockClient().client, baseUrl: 'https://x' },
      'createResendProvider(): set client, or apiKey and baseUrl, not both.',
    ],
    [
      'a client without emails.send()',
      { client: { send: () => {} } },
      'createResendProvider(): client must have an emails.send() method.',
    ],
    [
      'a null client',
      { client: null },
      'createResendProvider(): client must have an emails.send() method.',
    ],
    [
      'an empty API key',
      { apiKey: '' },
      'createResendProvider(): apiKey must be a non-empty string.',
    ],
    [
      'a base URL that is not a string',
      { apiKey: 're_x', baseUrl: 1 },
      'createResendProvider(): baseUrl must be a non-empty string.',
    ],
  ])('rejects %s', (_, options, text) => {
    expect(() => createResendProvider(options as never)).toThrow(
      new TypeError(text)
    )
  })
})

describe('Resend provider with the SDK client', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>

  beforeAll(async () => {
    server = await startHttpServer(({ body }) =>
      body.includes('rejected@example.com')
        ? {
            status: 422,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              statusCode: 422,
              name: 'validation_error',
              message: 'Invalid `to` field.',
            }),
          }
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 'email-1' }),
          }
    )
  })

  afterAll(() => server.close())

  const provider = () =>
    createResendProvider({ apiKey: 're_test', baseUrl: server.url })

  it('sends the request of the Resend API', async () => {
    expect(await mailerWith(provider()).sendMessage(message)).toEqual({
      messageId: 'email-1',
    })
    const request = server.requests.at(-1)!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/emails')
    expect(request.headers.authorization).toBe('Bearer re_test')
    expect(JSON.parse(request.body)).toMatchObject({
      from: '"Example" <noreply@example.com>',
      to: ['"Ada Lovelace" <ada@example.com>', 'grace@example.com'],
      bcc: ['archive@example.com'],
      reply_to: ['support@example.com', '"Sales" <sales@example.com>'],
      subject: 'Your invoice',
      html: '<p>Hello</p>',
      text: 'Hello',
      headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' },
      attachments: [
        {
          filename: 'invoice.pdf',
          content: 'AQID',
          content_type: 'application/pdf',
        },
        { filename: 'notes.txt', content: 'Tm90ZXMgw6k=' },
        { filename: 'logo.png', content: 'CQ==', content_id: 'logo' },
      ],
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
        'Mail not sent by the resend provider: validation_error: Invalid `to` field.',
      status: 422,
    })
  })

  it('creates a client from an API key only', () => {
    expect(createResendProvider({ apiKey: 're_test' }).name).toBe('resend')
  })
})
