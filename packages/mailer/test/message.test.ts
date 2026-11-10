import { describe, expect, it } from 'vitest'
import {
  createMailer,
  createMemoryProvider,
  formatAddress,
  MailerError,
  MailMessageError,
  type MessageOptions,
} from '../src/index.js'

const setup = (options: { replyTo?: string } = {}) => {
  const outbox = createMemoryProvider()
  const mailer = createMailer({
    provider: outbox,
    from: 'Example <noreply@example.com>',
    ...options,
  })
  const send = async (message: Partial<MessageOptions>) => {
    await mailer.sendMessage({
      to: 'ada@example.com',
      subject: 'Hello',
      text: 'Hello',
      ...message,
    } as MessageOptions)
    return outbox.last()
  }
  return { outbox, mailer, send }
}

const invalid = async (message: Record<string, unknown>, expected: string) => {
  const { send } = setup()
  const error = await send(message as never).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(MailMessageError)
  expect(error).toBeInstanceOf(MailerError)
  expect(error).toMatchObject({
    name: 'MailMessageError',
    message: `Invalid mail message: ${expected}`,
  })
}

describe('addresses', () => {
  it.each([
    ['ada@example.com', { address: 'ada@example.com' }],
    ['  ada@example.com  ', { address: 'ada@example.com' }],
    [
      'Ada Lovelace <ada@example.com>',
      { name: 'Ada Lovelace', address: 'ada@example.com' },
    ],
    [
      '"Lovelace, Ada" < ada@example.com >',
      { name: 'Lovelace, Ada', address: 'ada@example.com' },
    ],
    ['<ada@example.com>', { address: 'ada@example.com' }],
    ['"" <ada@example.com>', { address: 'ada@example.com' }],
    [
      { name: 'Ada', address: 'ada+test@mail.example.com' },
      { name: 'Ada', address: 'ada+test@mail.example.com' },
    ],
    [{ address: 'ada@example.com' }, { address: 'ada@example.com' }],
    [{ name: '', address: 'ada@example.com' }, { address: 'ada@example.com' }],
  ])('normalizes %j', async (to, expected) => {
    const { send } = setup()
    expect((await send({ to }))?.to).toStrictEqual([expected])
  })

  it('accepts lists', async () => {
    const { send } = setup()
    const message = await send({
      to: ['a@example.com', 'B <b@example.com>'],
      cc: 'c@example.com',
      bcc: [{ address: 'd@example.com' }],
      replyTo: ['e@example.com', 'f@example.com'],
    })
    expect(message).toMatchObject({
      to: [
        { address: 'a@example.com' },
        { name: 'B', address: 'b@example.com' },
      ],
      cc: [{ address: 'c@example.com' }],
      bcc: [{ address: 'd@example.com' }],
      replyTo: [{ address: 'e@example.com' }, { address: 'f@example.com' }],
    })
  })

  it('uses the sender and the reply-to addresses of the mailer', async () => {
    const { send } = setup({ replyTo: 'support@example.com' })
    expect(await send({})).toMatchObject({
      from: { name: 'Example', address: 'noreply@example.com' },
      replyTo: [{ address: 'support@example.com' }],
      cc: [],
      bcc: [],
    })
    expect(
      await send({ from: 'Other <other@example.com>', replyTo: [] })
    ).toMatchObject({
      from: { name: 'Other', address: 'other@example.com' },
      replyTo: [],
    })
  })

  it.each([
    [{ to: [] }, 'to needs at least one address.'],
    [{ to: undefined }, 'to needs at least one address.'],
    [{ to: 'ada' }, 'to is not an email address: "ada".'],
    [
      { to: 'a@b@example.com' },
      'to is not an email address: "a@b@example.com".',
    ],
    [
      { to: 'a b@example.com' },
      'to is not an email address: "a b@example.com".',
    ],
    [{ to: 'Ada <ada>' }, 'to is not an email address: "ada".'],
    [
      { to: 'a@example.com, b@example.com' },
      'to is not an email address: "a@example.com, b@example.com".',
    ],
    [{ to: ['a@example.com', 'b'] }, 'to[1] is not an email address: "b".'],
    [{ to: 1 }, 'to must be an email address.'],
    [{ to: [null] }, 'to[0] must be an email address.'],
    [{ to: {} }, 'to is not an email address: undefined.'],
    [{ cc: 'x' }, 'cc is not an email address: "x".'],
    [{ bcc: ['x'] }, 'bcc[0] is not an email address: "x".'],
    [{ replyTo: 'x' }, 'replyTo is not an email address: "x".'],
    [{ from: 'x' }, 'from is not an email address: "x".'],
    [
      { to: { name: 1, address: 'a@example.com' } },
      'to.name must be a string.',
    ],
    [
      { to: { name: 'Ada\r\nBcc: x@example.com', address: 'a@example.com' } },
      'to has a line break in its name.',
    ],
    [
      { to: 'Ada\nBcc: x@example.com <a@example.com>' },
      'to has a line break in its name.',
    ],
  ])('rejects %j', async (message, expected) => {
    await invalid(message, expected)
  })

  it('formats addresses for headers', () => {
    expect(formatAddress({ address: 'ada@example.com' })).toBe(
      'ada@example.com'
    )
    expect(formatAddress({ name: 'Ada', address: 'ada@example.com' })).toBe(
      '"Ada" <ada@example.com>'
    )
    expect(
      formatAddress({ name: 'A "B" \\ C', address: 'ada@example.com' })
    ).toBe('"A \\"B\\" \\\\ C" <ada@example.com>')
  })
})

describe('attachments', () => {
  it('keeps binary, text and inline attachments', async () => {
    const { send } = setup()
    const pdf = new Uint8Array([37, 80, 68, 70])
    const message = await send({
      attachments: [
        {
          filename: 'invoice.pdf',
          content: pdf,
          contentType: 'application/pdf',
        },
        { filename: 'notes.txt', content: 'Notes' },
        { filename: 'logo.png', content: pdf, contentId: 'logo' },
      ],
    })
    expect(message?.attachments).toStrictEqual([
      { filename: 'invoice.pdf', content: pdf, contentType: 'application/pdf' },
      { filename: 'notes.txt', content: 'Notes' },
      { filename: 'logo.png', content: pdf, contentId: 'logo' },
    ])
    expect(message?.attachments[0]?.content).toBe(pdf)
  })

  it('has no attachments by default', async () => {
    const { send } = setup()
    expect((await send({}))?.attachments).toStrictEqual([])
  })

  it.each([
    [{ attachments: {} }, 'attachments must be a list.'],
    [{ attachments: [null] }, 'attachments[0] must be an object.'],
    [{ attachments: [[]] }, 'attachments[0] must be an object.'],
    [
      { attachments: [{ content: 'x' }] },
      'attachments[0].filename must be a non-empty string.',
    ],
    [
      { attachments: [{ filename: '', content: 'x' }] },
      'attachments[0].filename must be a non-empty string.',
    ],
    [
      { attachments: [{ filename: 'a', content: 1 }] },
      'attachments[0].content must be a Uint8Array or a string.',
    ],
    [
      { attachments: [{ filename: 'a', content: [1] }] },
      'attachments[0].content must be a Uint8Array or a string.',
    ],
    [
      { attachments: [{ filename: 'a', content: 'x', contentType: 1 }] },
      'attachments[0].contentType must be a non-empty string on one line.',
    ],
    [
      { attachments: [{ filename: 'a', content: 'x', contentType: '' }] },
      'attachments[0].contentType must be a non-empty string on one line.',
    ],
    [
      {
        attachments: [
          { filename: 'a', content: 'x', contentType: 'text/plain\r\nX: y' },
        ],
      },
      'attachments[0].contentType must be a non-empty string on one line.',
    ],
    [
      { attachments: [{ filename: 'a', content: 'x', contentId: '\n' }] },
      'attachments[0].contentId must be a non-empty string on one line.',
    ],
  ])('rejects %j', async (message, expected) => {
    await invalid(message, expected)
  })
})

describe('headers', () => {
  it('keeps additional headers', async () => {
    const { send } = setup()
    const headers = {
      'List-Unsubscribe': '<https://example.com/unsubscribe>',
      'X-Campaign': 'spring',
    }
    expect((await send({ headers }))?.headers).toStrictEqual(headers)
    expect((await send({}))?.headers).toStrictEqual({})
  })

  it.each([
    [{ headers: [] }, 'headers must be an object.'],
    [{ headers: 'X: y' }, 'headers must be an object.'],
    [{ headers: { 'X Bad': 'y' } }, '"X Bad" is not a header name.'],
    [{ headers: { 'X-Name:': 'y' } }, '"X-Name:" is not a header name.'],
    [{ headers: { Subject: 'y' } }, 'the Subject header is set by the mailer.'],
    [{ headers: { BCC: 'y' } }, 'the BCC header is set by the mailer.'],
    [
      { headers: { 'Reply-To': 'y@example.com' } },
      'the Reply-To header is set by the mailer.',
    ],
    [
      { headers: { 'X-A': 'a\rBcc: x@example.com' } },
      'the X-A header must be a string on one line.',
    ],
    [
      { headers: { 'content-type': 'y' } },
      'the content-type header is set by the mailer.',
    ],
    [{ headers: { 'X-A': 1 } }, 'the X-A header must be a string on one line.'],
    [
      { headers: { 'X-A': 'a\r\nBcc: x@example.com' } },
      'the X-A header must be a string on one line.',
    ],
  ])('rejects %j', async (message, expected) => {
    await invalid(message, expected)
  })
})

describe('tags and metadata', () => {
  it('keeps unique tags, in order', async () => {
    const { send } = setup()
    const message = await send({
      tags: ['welcome', 'user_42', 'A-b', 'welcome', 'x'.repeat(256)],
      metadata: { userId: '42', 'invoice-id': 'F 2026/001 é' },
    })
    expect(message?.tags).toStrictEqual([
      'welcome',
      'user_42',
      'A-b',
      'x'.repeat(256),
    ])
    expect(message?.metadata).toStrictEqual({
      userId: '42',
      'invoice-id': 'F 2026/001 é',
    })
  })

  it('has no tags nor metadata by default', async () => {
    const { send } = setup()
    expect(await send({})).toMatchObject({ tags: [], metadata: {} })
  })

  it.each([
    [{ tags: 'welcome' }, 'tags must be a list.'],
    [
      { tags: ['ok', 'with space'] },
      'tags[1] must have 1 to 256 letters, digits, _ or -: "with space".',
    ],
    [{ tags: [''] }, 'tags[0] must have 1 to 256 letters, digits, _ or -: "".'],
    [
      { tags: ['x'.repeat(257)] },
      `tags[0] must have 1 to 256 letters, digits, _ or -: "${'x'.repeat(257)}".`,
    ],
    [
      { tags: ['é'] },
      'tags[0] must have 1 to 256 letters, digits, _ or -: "é".',
    ],
    [{ tags: [1] }, 'tags[0] must have 1 to 256 letters, digits, _ or -: 1.'],
    [{ metadata: [] }, 'metadata must be an object.'],
    [{ metadata: 'a=b' }, 'metadata must be an object.'],
    [
      { metadata: { 'user id': '1' } },
      'metadata keys must have 1 to 256 letters, digits, _ or -: "user id".',
    ],
    [
      { metadata: { '': '1' } },
      'metadata keys must have 1 to 256 letters, digits, _ or -: "".',
    ],
    [{ metadata: { a: 1 } }, 'metadata.a must be a string on one line.'],
    [{ metadata: { a: 'x\ny' } }, 'metadata.a must be a string on one line.'],
    [{ metadata: { a: 'x\ry' } }, 'metadata.a must be a string on one line.'],
  ])('rejects %j', async (message, expected) => {
    await invalid(message, expected)
  })
})
