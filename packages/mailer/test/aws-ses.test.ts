import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createMailer,
  MailMessageError,
  MailSendError,
  type MessageOptions,
} from '../src/index.js'
import { createSesProvider, type SesClient } from '../src/providers/aws-ses.js'

const message: MessageOptions = {
  to: ['Ada Lovelace <ada@example.com>', 'grace@example.com'],
  cc: { name: 'Zoë Ünal', address: 'zoe@example.com' },
  bcc: 'archive@example.com',
  replyTo: ['support@example.com'],
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
    { filename: 'data.csv', content: 'name\nZoë\n', contentType: 'text/csv' },
  ],
  headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' },
}

const minimalMessage: MessageOptions = {
  to: 'a@example.com',
  subject: 'Hi',
  text: 'Hi',
}

const mockClient = (output: object = { MessageId: 'ses-1' }) => {
  const send = vi.fn<(command: SendEmailCommand) => Promise<object>>(
    async () => output
  )
  return { client: { send } as unknown as SesClient, send }
}

const mailerWith = (provider: ReturnType<typeof createSesProvider>) =>
  createMailer({
    provider,
    from: 'Équipe <noreply@example.com>',
  })

describe('SES provider', () => {
  it('sends a SendEmail command with simple content', async () => {
    const { client, send } = mockClient()
    const provider = createSesProvider({
      client,
      configurationSetName: 'transactional',
    })
    expect(provider.name).toBe('aws-ses')

    const result = await mailerWith(provider).sendMessage(message)
    expect(result).toEqual({ messageId: 'ses-1' })
    expect(send).toHaveBeenCalledOnce()
    const command = send.mock.calls[0]?.[0]
    expect(command).toBeInstanceOf(SendEmailCommand)
    expect(command?.input).toStrictEqual({
      FromEmailAddress: '=?UTF-8?B?w4lxdWlwZQ==?= <noreply@example.com>',
      Destination: {
        ToAddresses: ['"Ada Lovelace" <ada@example.com>', 'grace@example.com'],
        CcAddresses: ['=?UTF-8?B?Wm/DqyDDnG5hbA==?= <zoe@example.com>'],
        BccAddresses: ['archive@example.com'],
      },
      ReplyToAddresses: ['support@example.com'],
      Content: {
        Simple: {
          Subject: { Data: 'Your invoice', Charset: 'UTF-8' },
          Body: {
            Text: { Data: 'Hello', Charset: 'UTF-8' },
            Html: { Data: '<p>Hello</p>', Charset: 'UTF-8' },
          },
          Headers: [
            {
              Name: 'List-Unsubscribe',
              Value: '<https://example.com/unsubscribe>',
            },
          ],
          Attachments: [
            {
              FileName: 'invoice.pdf',
              RawContent: new Uint8Array([1, 2, 3]),
              ContentType: 'application/pdf',
              ContentTransferEncoding: 'BASE64',
              ContentDisposition: 'ATTACHMENT',
            },
            {
              FileName: 'notes.txt',
              RawContent: new TextEncoder().encode('Notes é'),
              ContentTransferEncoding: 'BASE64',
              ContentDisposition: 'ATTACHMENT',
            },
            {
              FileName: 'data.csv',
              RawContent: new TextEncoder().encode('name\nZoë\n'),
              ContentType: 'text/csv; charset=utf-8',
              ContentTransferEncoding: 'BASE64',
              ContentDisposition: 'ATTACHMENT',
            },
          ],
        },
      },
      ConfigurationSetName: 'transactional',
    })
  })

  it('sends a message with inline images as raw content', async () => {
    const { client, send } = mockClient()
    const provider = createSesProvider({
      client,
      configurationSetName: 'transactional',
    })
    await mailerWith(provider).sendMessage({
      ...message,
      html: '<p>Hello</p><img src="cid:logo">',
      attachments: [
        {
          filename: 'logo.png',
          content: new Uint8Array([9]),
          contentId: 'logo',
        },
        { filename: 'invoice.pdf', content: new Uint8Array([1, 2, 3]) },
      ],
      metadata: { kind: 'receipt' },
    })
    const input = send.mock.calls[0]?.[0].input
    expect(input).toMatchObject({
      FromEmailAddress: '=?UTF-8?B?w4lxdWlwZQ==?= <noreply@example.com>',
      Destination: {
        ToAddresses: ['"Ada Lovelace" <ada@example.com>', 'grace@example.com'],
        CcAddresses: ['=?UTF-8?B?Wm/DqyDDnG5hbA==?= <zoe@example.com>'],
        BccAddresses: ['archive@example.com'],
      },
      ConfigurationSetName: 'transactional',
      EmailTags: [{ Name: 'kind', Value: 'receipt' }],
    })
    expect(input?.Content?.Simple).toBeUndefined()
    expect(input?.ReplyToAddresses).toBeUndefined()
    const raw = new TextDecoder().decode(input?.Content?.Raw?.Data)
    expect(raw).toMatch(
      /^From: =\?UTF-8\?B\?w4lxdWlwZQ==\?= <noreply@example.com>\r\n/
    )
    expect(raw).toContain('\r\nReply-To: support@example.com\r\n')
    expect(raw).toContain(
      '\r\nList-Unsubscribe: <https://example.com/unsubscribe>\r\n'
    )
    // Bcc only in the destination.
    expect(raw).not.toContain('archive@example.com')
    // The image with the HTML version, the PDF next to them.
    const related = raw.indexOf('multipart/related')
    expect(raw.indexOf('multipart/mixed')).toBeLessThan(related)
    expect(related).toBeLessThan(raw.indexOf('multipart/alternative'))
    expect(raw).toContain('Content-ID: <logo>')
  })

  it('keeps simple content for text-only messages and attachments', async () => {
    const { client, send } = mockClient()
    await mailerWith(createSesProvider({ client })).sendMessage({
      ...minimalMessage,
      attachments: [
        {
          filename: 'logo.png',
          content: new Uint8Array([9]),
          contentId: 'logo',
        },
      ],
    })
    expect(send.mock.calls[0]?.[0].input.Content?.Simple).toBeDefined()
  })

  it('declares UTF-8 only for text content with a text type and no charset', async () => {
    const { client, send } = mockClient()
    const bytes = new TextEncoder().encode('a;b\n')
    await mailerWith(createSesProvider({ client })).sendMessage({
      ...minimalMessage,
      attachments: [
        { filename: 'a.txt', content: 'é', contentType: 'TEXT/plain' },
        {
          filename: 'b.csv',
          content: 'é',
          contentType: 'text/csv; charset=iso-8859-1',
        },
        { filename: 'c.csv', content: bytes, contentType: 'text/csv' },
        { filename: 'd.json', content: '{}', contentType: 'application/json' },
      ],
    })
    const attachments =
      send.mock.calls[0]?.[0].input.Content?.Simple?.Attachments
    expect(attachments?.map((item) => item.ContentType)).toEqual([
      'TEXT/plain; charset=utf-8',
      'text/csv; charset=iso-8859-1',
      'text/csv',
      'application/json',
    ])
    expect(
      attachments?.every((item) => item.ContentTransferEncoding === 'BASE64')
    ).toBe(true)
  })

  it('sends text-only messages without configuration set', async () => {
    const { client, send } = mockClient({})
    const result = await mailerWith(createSesProvider({ client })).sendMessage({
      to: 'a@example.com',
      subject: 'Hi',
      text: 'Hi',
    })
    expect(result).toEqual({ messageId: undefined })
    const input = send.mock.calls[0]?.[0].input
    expect(input?.Content?.Simple?.Body).toStrictEqual({
      Text: { Data: 'Hi', Charset: 'UTF-8' },
    })
    expect(input).not.toHaveProperty('ConfigurationSetName')
    expect(input).not.toHaveProperty('EmailTags')
    expect(input?.FromEmailAddress).toBe(
      '=?UTF-8?B?w4lxdWlwZQ==?= <noreply@example.com>'
    )
  })

  it('sends tags and metadata as email tags', async () => {
    const { client, send } = mockClient()
    await mailerWith(createSesProvider({ client })).sendMessage({
      ...minimalMessage,
      tags: ['welcome', 'onboarding'],
      metadata: { userId: 'u-42', plan: 'pro_2026' },
    })
    expect(send.mock.calls[0]?.[0].input.EmailTags).toStrictEqual([
      { Name: 'welcome', Value: 'true' },
      { Name: 'onboarding', Value: 'true' },
      { Name: 'userId', Value: 'u-42' },
      { Name: 'plan', Value: 'pro_2026' },
    ])
  })

  it.each([
    [
      { metadata: { email: 'ada@example.com' } },
      'SES only accepts metadata values of 1 to 256 letters, digits, _ or -: metadata.email is "ada@example.com".',
    ],
    [
      { metadata: { empty: '' } },
      'SES only accepts metadata values of 1 to 256 letters, digits, _ or -: metadata.empty is "".',
    ],
    [
      { metadata: { long: 'x'.repeat(257) } },
      `SES only accepts metadata values of 1 to 256 letters, digits, _ or -: metadata.long is "${'x'.repeat(257)}".`,
    ],
    [
      { tags: ['plan'], metadata: { plan: 'pro' } },
      'SES stores tags and metadata together: "plan" cannot be both a tag and a metadata key.',
    ],
  ])('rejects the metadata %j', async (extra, text) => {
    const { client, send } = mockClient()
    const error = await mailerWith(createSesProvider({ client }))
      .sendMessage({ ...minimalMessage, ...extra })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailMessageError)
    expect((error as Error).message).toBe(`Invalid mail message: ${text}`)
    expect(send).not.toHaveBeenCalled()
  })

  it('reports SES errors with their HTTP status', async () => {
    const failure = Object.assign(new Error('Email address is not verified.'), {
      name: 'MessageRejected',
      $metadata: { httpStatusCode: 400 },
    })
    const error = await mailerWith(
      createSesProvider({ client: { send: () => Promise.reject(failure) } })
    )
      .sendMessage({ to: 'a@example.com', subject: 'Hi', text: 'Hi' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toMatchObject({
      message:
        'Mail not sent by the aws-ses provider: MessageRejected: Email address is not verified.',
      provider: 'aws-ses',
      status: 400,
      cause: failure,
    })
  })

  it.each([
    ['a value that is not an error', 'timeout', 'timeout'],
    ['null', null, 'null'],
    ['an error without metadata', new TypeError('boom'), 'TypeError: boom'],
    [
      'an invalid status',
      Object.assign(new Error('x'), { $metadata: { httpStatusCode: '500' } }),
      'Error: x',
    ],
  ])('reports %s', async (_, failure, text) => {
    const error = await mailerWith(
      createSesProvider({ client: { send: () => Promise.reject(failure) } })
    )
      .sendMessage({ to: 'a@example.com', subject: 'Hi', text: 'Hi' })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({
      message: `Mail not sent by the aws-ses provider: ${text}`,
      status: undefined,
    })
  })

  it.each([
    [
      'not an object',
      'x',
      'createSesProvider(): expected an object of options.',
    ],
    [
      'an unknown option',
      { region: 'eu-west-3' },
      'createSesProvider(): unknown option "region".',
    ],
    [
      'both client and clientConfig',
      { client: { send: () => {} }, clientConfig: {} },
      'createSesProvider(): set client or clientConfig, not both.',
    ],
    [
      'a client without send()',
      { client: {} },
      'createSesProvider(): client must have a send() method.',
    ],
    [
      'a null client',
      { client: null },
      'createSesProvider(): client must have a send() method.',
    ],
    [
      'an empty configuration set',
      { configurationSetName: '' },
      'createSesProvider(): configurationSetName must be a non-empty string.',
    ],
    [
      'a configuration set that is not a string',
      { configurationSetName: 1 },
      'createSesProvider(): configurationSetName must be a non-empty string.',
    ],
  ])('rejects %s', (_, options, text) => {
    expect(() => createSesProvider(options as never)).toThrow(
      new TypeError(text)
    )
  })
})

describe('SES provider with the AWS SDK client', () => {
  interface Request {
    method: string | undefined
    url: string | undefined
    headers: IncomingMessage['headers']
    body: Record<string, unknown>
  }
  const requests: Request[] = []
  let server: Server
  let endpoint: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        })
        if (JSON.stringify(body).includes('rejected@example.com')) {
          res.writeHead(400, {
            'content-type': 'application/json',
            'x-amzn-errortype': 'MessageRejected',
          })
          res.end(JSON.stringify({ message: 'Email address is not verified.' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ MessageId: 'aws-message-1' }))
      })
    })
    // Never closes idle connections itself: undici could reuse a connection
    // as the server closes it ("fetch failed", seen on Node.js 22 in CI).
    server.keepAliveTimeout = 0
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const provider = () =>
    createSesProvider({
      clientConfig: {
        endpoint,
        region: 'eu-west-3',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      },
    })

  it('sends the request of the SES API v2', async () => {
    const result = await mailerWith(provider()).sendMessage(message)
    expect(result).toEqual({ messageId: 'aws-message-1' })

    const request = requests.at(-1) as Request
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/v2/email/outbound-emails')
    expect(request.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=test\/\d{8}\/eu-west-3\/ses\/aws4_request/
    )
    expect(request.body).toMatchObject({
      FromEmailAddress: '=?UTF-8?B?w4lxdWlwZQ==?= <noreply@example.com>',
      Destination: {
        ToAddresses: ['"Ada Lovelace" <ada@example.com>', 'grace@example.com'],
        BccAddresses: ['archive@example.com'],
      },
      Content: {
        Simple: {
          Attachments: [
            {
              FileName: 'invoice.pdf',
              RawContent: 'AQID',
              ContentType: 'application/pdf',
              ContentTransferEncoding: 'BASE64',
              ContentDisposition: 'ATTACHMENT',
            },
            {
              FileName: 'notes.txt',
              RawContent: Buffer.from('Notes é').toString('base64'),
              ContentTransferEncoding: 'BASE64',
              ContentDisposition: 'ATTACHMENT',
            },
            {
              FileName: 'data.csv',
              RawContent: Buffer.from('name\nZoë\n').toString('base64'),
              ContentType: 'text/csv; charset=utf-8',
              ContentTransferEncoding: 'BASE64',
              ContentDisposition: 'ATTACHMENT',
            },
          ],
          Headers: [
            {
              Name: 'List-Unsubscribe',
              Value: '<https://example.com/unsubscribe>',
            },
          ],
        },
      },
    })
  })

  it('reports API errors', async () => {
    const error = await mailerWith(provider())
      .sendMessage({ to: 'rejected@example.com', subject: 'Hi', text: 'Hi' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toMatchObject({
      message:
        'Mail not sent by the aws-ses provider: MessageRejected: Email address is not verified.',
      status: 400,
    })
  })

  it('creates a client from the environment by default', () => {
    const provider = createSesProvider()
    expect(provider.name).toBe('aws-ses')
    expect(new SESv2Client({})).toBeInstanceOf(SESv2Client)
  })
})
