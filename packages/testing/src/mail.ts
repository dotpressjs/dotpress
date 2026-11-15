import { assertCount, checkTimes, matches, show } from './assertions.js'

/** An address of a sent mail. */
export interface SentMailAddress {
  readonly name?: string
  readonly address: string
}

/** The fields of a message read here (`SentMail` of `@dotpress/mailer`). */
export interface SentMail {
  readonly from: SentMailAddress
  readonly to: readonly SentMailAddress[]
  readonly cc: readonly SentMailAddress[]
  readonly bcc: readonly SentMailAddress[]
  readonly replyTo: readonly SentMailAddress[]
  readonly subject: string
  readonly template: string | undefined
}

/** Where messages are read: `createMemoryProvider()` of `@dotpress/mailer`. */
export interface MailOutbox<M extends SentMail = SentMail> {
  readonly sent: readonly M[]
}

/** Recipients: every expected address must be among them (any case). */
/** Expected addresses: one, or several. */
export type ExpectedAddresses = string | readonly string[]

/**
 * Expected properties of a message. Recipients and `from` are compared by
 * address; the other properties are matched like `toMatchObject()`
 * (asymmetric matchers accepted: `expect.stringContaining()`…).
 */
export interface MailCriteria {
  to?: ExpectedAddresses | undefined
  cc?: ExpectedAddresses | undefined
  bcc?: ExpectedAddresses | undefined
  replyTo?: ExpectedAddresses | undefined
  from?: string | undefined
  /** The template, or its name. */
  template?: string | { readonly name: string } | undefined
  locale?: unknown
  subject?: unknown
  html?: unknown
  text?: unknown
  tags?: unknown
  metadata?: unknown
  headers?: unknown
  attachments?: unknown
}

/** Options of `expectMailSent()`. */
export interface ExpectMailOptions {
  /** Exact number of matching messages. Defaults to at least one. */
  times?: number | undefined
}

const ADDRESS_KEYS = ['to', 'cc', 'bcc', 'replyTo'] as const
const KEYS = new Set([
  ...ADDRESS_KEYS,
  'from',
  'template',
  'locale',
  'subject',
  'html',
  'text',
  'tags',
  'metadata',
  'headers',
  'attachments',
])

const lower = (address: string) => address.trim().toLowerCase()

const checkAddresses = (label: string, key: string, value: unknown) => {
  const list = typeof value === 'string' ? [value] : value
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((item) => typeof item === 'string' && item.trim() !== '')
  ) {
    throw new TypeError(
      `${label}: ${key} must be an email address, or a non-empty array of them.`
    )
  }
  return (list as string[]).map(lower)
}

/** A predicate for the criteria; checks them once. */
const predicateOf = (label: string, criteria: unknown) => {
  if (typeof criteria !== 'object' || criteria === null) {
    throw new TypeError(`${label}: expected an object of criteria.`)
  }
  const values = criteria as Record<string, unknown>
  for (const key of Object.keys(values)) {
    if (!KEYS.has(key)) {
      throw new TypeError(`${label}: unknown criterion "${key}".`)
    }
  }
  const addresses = ADDRESS_KEYS.flatMap((key) =>
    values[key] === undefined
      ? []
      : [{ key, expected: checkAddresses(label, key, values[key]) }]
  )
  const { from, template } = values
  if (from !== undefined && (typeof from !== 'string' || from.trim() === '')) {
    throw new TypeError(`${label}: from must be an email address.`)
  }
  const templateName =
    template === undefined
      ? undefined
      : typeof template === 'string'
        ? template
        : (template as { name?: unknown } | null)?.name
  if (template !== undefined && typeof templateName !== 'string') {
    throw new TypeError(`${label}: template must be a template, or its name.`)
  }
  const others = Object.entries(values).filter(
    ([key, value]) =>
      value !== undefined &&
      !(ADDRESS_KEYS as readonly string[]).includes(key) &&
      key !== 'from' &&
      key !== 'template'
  )

  return (message: SentMail) =>
    addresses.every(({ key, expected }) => {
      const actual = (message[key] as readonly SentMailAddress[]).map(
        ({ address }) => lower(address)
      )
      return expected.every((address) => actual.includes(address))
    }) &&
    (from === undefined ||
      lower(message.from.address) === lower(from as string)) &&
    (templateName === undefined || message.template === templateName) &&
    others.every(([key, value]) =>
      matches((message as unknown as Record<string, unknown>)[key], value)
    )
}

const outboxOf = (label: string, outbox: unknown): readonly SentMail[] => {
  const sent = (outbox as MailOutbox | null)?.sent
  if (!Array.isArray(sent)) {
    throw new TypeError(
      `${label}: expected the memory provider of the mailer (createMemoryProvider()).`
    )
  }
  return sent as readonly SentMail[]
}

const recipients = (addresses: readonly SentMailAddress[]) =>
  addresses.map(({ address }) => address).join(', ')

const recordedOf = (messages: readonly SentMail[]) =>
  messages.length === 0
    ? 'No message was sent.'
    : `Sent messages:\n${messages
        .map(
          (message) =>
            `  - to ${recipients(message.to)}: ${show(message.subject)}${message.template === undefined ? '' : ` (template ${message.template})`}`
        )
        .join('\n')}`

const describeCriteria = (criteria: object) => {
  const shown = Object.keys(criteria).length === 0 ? '' : ` ${show(criteria)}`
  return {
    some: `a message${shown} sent`,
    none: `no message${shown} sent`,
  }
}

/**
 * Asserts that a message matching the criteria was sent, at least once or
 * exactly `times` times. Returns the last matching message.
 *
 * ```ts
 * const outbox = createMemoryProvider()
 * const mailer = createMailer({ provider: outbox, from: 'noreply@example.com' })
 * await signUp(mailer, 'ada@example.com')
 * const mail = expectMailSent(outbox, { to: 'ada@example.com', template: welcomeMail })
 * expect(mail.html).toContain('https://example.com/confirm')
 * ```
 */
export const expectMailSent = <M extends SentMail>(
  outbox: MailOutbox<M>,
  criteria: MailCriteria = {},
  options: ExpectMailOptions = {}
): M => {
  const label = 'expectMailSent()'
  const messages = outboxOf(label, outbox)
  const matching = predicateOf(label, criteria)
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (key !== 'times') {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  checkTimes(label, options.times)
  if (options.times === 0) {
    throw new TypeError(
      `${label}: times must be at least 1 (use expectNoMailSent()).`
    )
  }
  const found = messages.filter(matching)
  assertCount(
    describeCriteria(criteria),
    found.length,
    options.times,
    recordedOf(messages)
  )
  return found.at(-1) as M
}

/**
 * Asserts that no message (matching the criteria, if given) was sent.
 *
 * ```ts
 * expectNoMailSent(outbox, { to: 'ada@example.com' })
 * ```
 */
export const expectNoMailSent = (
  outbox: MailOutbox,
  criteria: MailCriteria = {}
): void => {
  const label = 'expectNoMailSent()'
  const messages = outboxOf(label, outbox)
  const found = messages.filter(predicateOf(label, criteria))
  assertCount(describeCriteria(criteria), found.length, 0, recordedOf(messages))
}
