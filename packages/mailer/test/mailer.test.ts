import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createMailer,
  createMemoryProvider,
  defineTemplate,
  MailDataError,
  MailerError,
  MailMessageError,
  MailSendError,
  type MailProvider,
} from '../src/index.js'

const welcome = defineTemplate({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: { en: 'Welcome {{name}}', fr: 'Bienvenue {{name}}' },
  translations: { body: { en: 'Hello', fr: 'Bonjour' } },
  html: ({ t }) => `<p>${t('body')} {{name}}</p>`,
})

const setup = (options: Record<string, unknown> = {}) => {
  const outbox = createMemoryProvider()
  const mailer = createMailer({
    provider: outbox,
    from: 'noreply@example.com',
    defaultLocale: 'en',
    ...options,
  })
  return { outbox, mailer }
}

const failing = (error: unknown): MailProvider => ({
  name: 'failing',
  send: () => Promise.reject(error),
})

describe('createMailer()', () => {
  it.each([
    [
      'not an object',
      null,
      'Invalid mailer options: expected an object of options.',
    ],
    ['an array', [], 'Invalid mailer options: expected an object of options.'],
    [
      'an unknown option',
      { defaultSender: 'a@example.com' },
      'Invalid mailer options: unknown option "defaultSender".',
    ],
    [
      'no provider',
      { from: 'a@example.com' },
      'Invalid mailer options: provider must have a name and a send() method.',
    ],
    [
      'a provider without name',
      { from: 'a@example.com', provider: { name: '', send: () => {} } },
      'Invalid mailer options: provider must have a name and a send() method.',
    ],
    [
      'a provider without send()',
      { from: 'a@example.com', provider: { name: 'x', sendMail: () => {} } },
      'Invalid mailer options: provider must have a name and a send() method.',
    ],
    [
      'no sender',
      { provider: createMemoryProvider() },
      'Invalid mailer options: from is required.',
    ],
    [
      'an empty default locale',
      {
        from: 'a@example.com',
        provider: createMemoryProvider(),
        defaultLocale: '',
      },
      'Invalid mailer options: defaultLocale must be a non-empty string.',
    ],
    [
      'a default locale that is not a string',
      {
        from: 'a@example.com',
        provider: createMemoryProvider(),
        defaultLocale: 1,
      },
      'Invalid mailer options: defaultLocale must be a non-empty string.',
    ],
    [
      'a logger without info()',
      { from: 'a@example.com', provider: createMemoryProvider(), logger: {} },
      'Invalid mailer logger: expected an info() method.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createMailer(options as never)).toThrow(new TypeError(message))
  })

  it('checks the default addresses', () => {
    expect(() =>
      createMailer({ provider: createMemoryProvider(), from: 'noreply' })
    ).toThrow(new MailMessageError('from is not an email address: "noreply".'))
    expect(() =>
      createMailer({
        provider: createMemoryProvider(),
        from: 'noreply@example.com',
        replyTo: ['x'],
      })
    ).toThrow(new MailMessageError('replyTo[0] is not an email address: "x".'))
  })

  it('returns a frozen mailer', () => {
    const { mailer, outbox } = setup()
    expect(Object.isFrozen(mailer)).toBe(true)
    expect(mailer.provider).toBe(outbox)
  })
})

describe('mailer.send()', () => {
  it('renders the template and sends it', async () => {
    const { mailer, outbox } = setup()
    const result = await mailer.send(welcome, {
      to: 'Ada <ada@example.com>',
      locale: 'fr-CA',
      data: { name: 'Ada' },
    })

    expect(result).toEqual({ messageId: 'memory-1' })
    expect(outbox.sent).toHaveLength(1)
    expect(outbox.last()).toStrictEqual({
      from: { address: 'noreply@example.com' },
      to: [{ name: 'Ada', address: 'ada@example.com' }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: 'Bienvenue Ada',
      html: '<p>Bonjour Ada</p>',
      text: 'Bonjour Ada',
      attachments: [],
      headers: {},
      template: 'welcome',
      locale: 'fr',
    })
  })

  it('uses the default locale of the mailer', async () => {
    const { mailer, outbox } = setup()
    await mailer.send(welcome, { to: 'a@example.com', data: { name: 'Ada' } })
    await mailer.send(welcome, {
      to: 'a@example.com',
      locale: 'de',
      data: { name: 'Ada' },
    })
    expect(outbox.sent.map((message) => message.locale)).toEqual(['en', 'en'])
  })

  it('overrides the subject, on one line', async () => {
    const { mailer, outbox } = setup()
    await mailer.send(welcome, {
      to: 'a@example.com',
      subject: ' Custom\r\nsubject ',
      data: { name: 'Ada' },
    })
    expect(outbox.last()?.subject).toBe('Custom subject')
  })

  it('freezes the message', async () => {
    const { mailer, outbox } = setup()
    await mailer.send(welcome, {
      to: 'a@example.com',
      attachments: [{ filename: 'a.txt', content: 'A' }],
      headers: { 'X-A': 'a' },
      data: { name: 'Ada' },
    })
    const message = outbox.last()
    expect(Object.isFrozen(message)).toBe(true)
    for (const key of [
      'from',
      'to',
      'cc',
      'bcc',
      'replyTo',
      'attachments',
      'headers',
    ] as const) {
      expect(Object.isFrozen(message?.[key])).toBe(true)
    }
  })

  it('checks the recipients before rendering', async () => {
    const { mailer, outbox } = setup()
    await expect(
      mailer.send(welcome, { to: 'nobody', data: {} as never })
    ).rejects.toBeInstanceOf(MailMessageError)
    await expect(
      mailer.send(welcome, { to: 'a@example.com', data: {} as never })
    ).rejects.toBeInstanceOf(MailDataError)
    expect(outbox.sent).toHaveLength(0)
  })

  it.each([
    ['not an object', null, 'mailer.send(): expected an object of options.'],
    [
      'an unknown option (V1 name)',
      { recipient: 'a@example.com' },
      'mailer.send(): unknown option "recipient".',
    ],
    [
      'a subject that is not a string',
      { to: 'a@example.com', subject: 1, data: { name: 'Ada' } },
      'mailer.send(): subject must be a string.',
    ],
  ])('rejects %s', async (_, options, message) => {
    const { mailer } = setup()
    await expect(mailer.send(welcome, options as never)).rejects.toThrow(
      new TypeError(message)
    )
  })
})

describe('mailer.render()', () => {
  it('renders with the default locale of the mailer', async () => {
    const { mailer, outbox } = setup()
    expect(await mailer.render(welcome, { data: { name: 'Ada' } })).toEqual({
      template: 'welcome',
      locale: 'en',
      subject: 'Welcome Ada',
      html: '<p>Hello Ada</p>',
      text: 'Hello Ada',
    })
    const french = await mailer.render(welcome, {
      locale: 'de',
      defaultLocale: 'fr',
      data: { name: 'Ada' },
    })
    expect(french.locale).toBe('fr')
    expect(outbox.sent).toHaveLength(0)
  })

  it('renders without default locale', async () => {
    const { mailer } = setup({ defaultLocale: undefined })
    await expect(
      mailer.render(welcome, { data: { name: 'Ada' } })
    ).rejects.toThrow('no locale requested and no default locale')
  })
})

describe('mailer.sendMessage()', () => {
  it('converts the HTML version to text', async () => {
    const { mailer, outbox } = setup()
    const result = await mailer.sendMessage({
      to: 'a@example.com',
      subject: 'Report\nready',
      html: '<h1>Report</h1><p>Ready.</p>',
    })
    expect(result.messageId).toBe('memory-1')
    expect(outbox.last()).toMatchObject({
      subject: 'Report ready',
      html: '<h1>Report</h1><p>Ready.</p>',
      text: 'REPORT\n\nReady.',
      template: undefined,
      locale: undefined,
    })
  })

  it('sends text-only messages', async () => {
    const { mailer, outbox } = setup()
    await mailer.sendMessage({ to: 'a@example.com', subject: 'Hi', text: 'Hi' })
    expect(outbox.last()).toMatchObject({ html: undefined, text: 'Hi' })
  })

  it('keeps both versions', async () => {
    const { mailer, outbox } = setup()
    await mailer.sendMessage({
      to: 'a@example.com',
      subject: 'Hi',
      html: '<p>HTML</p>',
      text: 'Text',
    })
    expect(outbox.last()).toMatchObject({ html: '<p>HTML</p>', text: 'Text' })
  })

  it.each([
    [
      'no content',
      { to: 'a@example.com', subject: 'Hi' },
      'mailer.sendMessage(): set html, text, or both.',
    ],
    [
      'no subject',
      { to: 'a@example.com', text: 'Hi' },
      'mailer.sendMessage(): subject must be a string.',
    ],
    [
      'an HTML version that is not a string',
      { to: 'a@example.com', subject: 'Hi', html: 1 },
      'mailer.sendMessage(): html must be a string.',
    ],
    [
      'a text version that is not a string',
      { to: 'a@example.com', subject: 'Hi', text: null },
      'mailer.sendMessage(): text must be a string.',
    ],
    [
      'an unknown option',
      { to: 'a@example.com', subject: 'Hi', text: 'Hi', data: {} },
      'mailer.sendMessage(): unknown option "data".',
    ],
    [
      'not an object',
      'a',
      'mailer.sendMessage(): expected an object of options.',
    ],
  ])('rejects %s', async (_, options, message) => {
    const { mailer } = setup()
    await expect(mailer.sendMessage(options as never)).rejects.toThrow(
      new TypeError(message)
    )
  })
})

describe('provider results and errors', () => {
  const send = (provider: MailProvider) =>
    createMailer({ provider, from: 'a@example.com' }).sendMessage({
      to: 'b@example.com',
      subject: 'Hi',
      text: 'Hi',
    })

  it('returns the message ID of the provider, if any', async () => {
    expect(await send({ name: 'x', send: async () => {} })).toEqual({
      messageId: undefined,
    })
    expect(
      await send({ name: 'x', send: async () => ({ messageId: 1 }) as never })
    ).toEqual({ messageId: undefined })
    expect(
      await send({ name: 'x', send: async () => ({ messageId: 'id-1' }) })
    ).toEqual({ messageId: 'id-1' })
  })

  it('wraps provider errors', async () => {
    const cause = new Error('connection refused')
    const error = await send(failing(cause)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toBeInstanceOf(MailerError)
    expect(error).toMatchObject({
      name: 'MailSendError',
      message: 'Mail not sent by the failing provider: connection refused',
      provider: 'failing',
      status: undefined,
      cause,
    })
  })

  it('wraps values that are not errors', async () => {
    await expect(send(failing('timeout'))).rejects.toThrow(
      new MailSendError('failing', 'timeout')
    )
  })

  it('rethrows send errors of the provider', async () => {
    const error = new MailSendError('api', 'rate limited', { status: 429 })
    expect(error.status).toBe(429)
    expect(error.message).toBe(
      'Mail not sent by the api provider: rate limited'
    )
    await expect(send(failing(error))).rejects.toBe(error)
  })
})

describe('logs', () => {
  it('logs sent messages without addresses', async () => {
    const logger = { info: vi.fn() }
    const { mailer } = setup({ logger })
    await mailer.send(welcome, {
      to: ['a@example.com', 'b@example.com'],
      cc: 'c@example.com',
      bcc: 'd@example.com',
      data: { name: 'Ada' },
    })
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      {
        provider: 'memory',
        template: 'welcome',
        messageId: 'memory-1',
        recipients: 4,
      },
      'Mail sent'
    )
  })

  it('does not log failures (they are thrown)', async () => {
    const logger = { info: vi.fn() }
    const mailer = createMailer({
      provider: failing(new Error('down')),
      from: 'a@example.com',
      logger,
    })
    await expect(
      mailer.sendMessage({ to: 'b@example.com', subject: 'Hi', text: 'Hi' })
    ).rejects.toThrow(MailSendError)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('withLogger() returns the same mailer with another logger', async () => {
    const first = { info: vi.fn() }
    const second = { info: vi.fn() }
    const { mailer, outbox } = setup({ logger: first })
    const other = mailer.withLogger(second)

    expect(other).not.toBe(mailer)
    expect(Object.isFrozen(other)).toBe(true)
    expect(other.provider).toBe(outbox)
    await other.send(welcome, { to: 'a@example.com', data: { name: 'Ada' } })
    expect(second.info).toHaveBeenCalledOnce()
    expect(first.info).not.toHaveBeenCalled()
    // Same defaults.
    expect(outbox.last()).toMatchObject({
      from: { address: 'noreply@example.com' },
      locale: 'en',
    })
    expect(() => mailer.withLogger({} as never)).toThrow(
      'Invalid mailer logger: expected an info() method.'
    )
  })

  it('works without logger', async () => {
    const { mailer } = setup()
    await expect(
      mailer.send(welcome, { to: 'a@example.com', data: { name: 'Ada' } })
    ).resolves.toEqual({ messageId: 'memory-1' })
  })
})
