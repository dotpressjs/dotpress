import { MailMessageError } from './errors.js'

/** An email address, normalized. */
export interface Address {
  /** Display name, like `Ada Lovelace`. */
  readonly name?: string
  /** Email address, like `ada@example.com`. */
  readonly address: string
}

/**
 * An email address: `'ada@example.com'`, `'Ada Lovelace <ada@example.com>'`
 * or `{ name: 'Ada Lovelace', address: 'ada@example.com' }`.
 */
export type MailAddress = string | Address

/** One or more email addresses. */
export type MailRecipients = MailAddress | readonly MailAddress[]

/** A file attached to a message. */
export interface MailAttachment {
  /** File name shown by email clients. */
  readonly filename: string
  /** Binary content, or text content (UTF-8). */
  readonly content: Uint8Array | string
  /** MIME type, like `application/pdf`. Guessed by the provider if missing. */
  readonly contentType?: string
  /**
   * Makes the attachment inline: the HTML version references it with
   * `cid:` (`<img src="cid:logo">`).
   */
  readonly contentId?: string
}

/** Message given to providers. */
export interface MailMessage {
  readonly from: Address
  /** At least one address. */
  readonly to: readonly Address[]
  readonly cc: readonly Address[]
  readonly bcc: readonly Address[]
  readonly replyTo: readonly Address[]
  /** Single line. */
  readonly subject: string
  /** HTML version; undefined for a text-only message. */
  readonly html: string | undefined
  readonly text: string
  readonly attachments: readonly MailAttachment[]
  /** Additional headers, like `List-Unsubscribe`. */
  readonly headers: Readonly<Record<string, string>>
  /** Labels to group messages in the statistics of the provider. */
  readonly tags: readonly string[]
  /** Key/value pairs returned by the webhooks of the provider. */
  readonly metadata: Readonly<Record<string, string>>
  /** Name of the template, if the message was rendered from one. */
  readonly template: string | undefined
  /** Rendered locale, if any. */
  readonly locale: string | undefined
}

/** Recipients and options shared by every message. */
export interface EnvelopeOptions {
  to: MailRecipients
  cc?: MailRecipients | undefined
  bcc?: MailRecipients | undefined
  /** Defaults to the `replyTo` option of the mailer. */
  replyTo?: MailRecipients | undefined
  /** Defaults to the `from` option of the mailer. */
  from?: MailAddress | undefined
  attachments?: readonly MailAttachment[] | undefined
  /** Additional headers, like `List-Unsubscribe`. */
  headers?: Readonly<Record<string, string>> | undefined
  /**
   * Labels to group messages in the statistics of the provider: letters,
   * digits, `_` and `-`. Ignored by providers without tags.
   */
  tags?: readonly string[] | undefined
  /**
   * Key/value pairs returned by the webhooks of the provider, to link an
   * event to the app. Keys: letters, digits, `_` and `-`. Ignored by
   * providers without metadata.
   */
  metadata?: Readonly<Record<string, string>> | undefined
}

/** Envelope of a message, validated. */
export interface Envelope {
  readonly from: Address
  readonly to: readonly Address[]
  readonly cc: readonly Address[]
  readonly bcc: readonly Address[]
  readonly replyTo: readonly Address[]
  readonly attachments: readonly MailAttachment[]
  readonly headers: Readonly<Record<string, string>>
  readonly tags: readonly string[]
  readonly metadata: Readonly<Record<string, string>>
}

const fail = (message: string): never => {
  throw new MailMessageError(message)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Pragmatic check: one @, no spaces, nor characters that break headers.
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/
const NAMED = /^([\s\S]*?)\s*<([^<>]*)>$/
const LINE_BREAK = /[\r\n]/
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// The strictest rule of the providers (SES, Resend): valid everywhere.
const TAG = /^[A-Za-z0-9_-]{1,256}$/

// Set by the mailer or the provider.
const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
])

/** Normalizes and checks an address. */
export const parseAddress = (value: unknown, label: string): Address => {
  let name: unknown
  let address: unknown
  if (typeof value === 'string') {
    const named = NAMED.exec(value.trim())
    if (named) {
      // Optional quotes around the name.
      name = (named[1] as string).replace(/^"(.*)"$/, '$1').trim()
      address = (named[2] as string).trim()
    } else {
      address = value.trim()
    }
  } else if (isRecord(value)) {
    ;({ name, address } = value)
    if (name !== undefined && typeof name !== 'string') {
      fail(`${label}.name must be a string.`)
    }
  } else {
    fail(`${label} must be an email address.`)
  }

  if (typeof address !== 'string' || !EMAIL.test(address)) {
    fail(`${label} is not an email address: ${JSON.stringify(address)}.`)
  }
  if (typeof name === 'string' && LINE_BREAK.test(name)) {
    fail(`${label} has a line break in its name.`)
  }
  return name
    ? { name: name as string, address: address as string }
    : { address: address as string }
}

/** Normalizes and checks a list of addresses. */
export const parseRecipients = (value: unknown, label: string): Address[] => {
  if (value === undefined) return []
  const list: unknown[] = Array.isArray(value) ? value : [value]
  return list.map((item, index) =>
    parseAddress(item, Array.isArray(value) ? `${label}[${index}]` : label)
  )
}

const parseAttachments = (value: unknown): MailAttachment[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('attachments must be a list.')

  return (value as unknown[]).map((attachment, index) => {
    const label = `attachments[${index}]`
    if (!isRecord(attachment)) fail(`${label} must be an object.`)
    const { filename, content, contentType, contentId } = attachment as Record<
      string,
      unknown
    >
    if (typeof filename !== 'string' || filename === '') {
      fail(`${label}.filename must be a non-empty string.`)
    }
    if (!(content instanceof Uint8Array) && typeof content !== 'string') {
      fail(`${label}.content must be a Uint8Array or a string.`)
    }
    for (const [key, field] of [
      ['contentType', contentType],
      ['contentId', contentId],
    ] as const) {
      if (
        field !== undefined &&
        (typeof field !== 'string' || field === '' || LINE_BREAK.test(field))
      ) {
        fail(`${label}.${key} must be a non-empty string on one line.`)
      }
    }
    return {
      filename: filename as string,
      content: content as Uint8Array | string,
      ...(contentType === undefined
        ? {}
        : { contentType: contentType as string }),
      ...(contentId === undefined ? {} : { contentId: contentId as string }),
    }
  })
}

const parseHeaders = (value: unknown): Record<string, string> => {
  if (value === undefined) return {}
  if (!isRecord(value)) fail('headers must be an object.')

  const headers: Record<string, string> = {}
  for (const [name, header] of Object.entries(value as object)) {
    if (!TOKEN.test(name)) fail(`"${name}" is not a header name.`)
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      fail(`the ${name} header is set by the mailer.`)
    }
    if (typeof header !== 'string' || LINE_BREAK.test(header)) {
      fail(`the ${name} header must be a string on one line.`)
    }
    headers[name] = header as string
  }
  return headers
}

const parseTags = (value: unknown): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('tags must be a list.')
  const tags = new Set<string>()
  for (const [index, tag] of (value as unknown[]).entries()) {
    if (typeof tag !== 'string' || !TAG.test(tag)) {
      fail(
        `tags[${index}] must have 1 to 256 letters, digits, _ or -: ${JSON.stringify(tag)}.`
      )
    }
    tags.add(tag as string)
  }
  return [...tags]
}

const parseMetadata = (value: unknown): Record<string, string> => {
  if (value === undefined) return {}
  if (!isRecord(value)) fail('metadata must be an object.')

  const metadata: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as object)) {
    if (!TAG.test(key)) {
      fail(
        `metadata keys must have 1 to 256 letters, digits, _ or -: ${JSON.stringify(key)}.`
      )
    }
    if (typeof item !== 'string' || LINE_BREAK.test(item)) {
      fail(`metadata.${key} must be a string on one line.`)
    }
    metadata[key] = item as string
  }
  return metadata
}

/** Single-line subject. */
export const toSubject = (subject: string) =>
  subject.replace(/\s*[\r\n]+\s*/g, ' ').trim()

/**
 * Validates the envelope options of a message. `defaults` provides the
 * sender and the reply-to addresses of the mailer.
 */
export const parseEnvelope = (
  options: EnvelopeOptions,
  defaults: { from: Address; replyTo: readonly Address[] }
): Envelope => {
  const to = parseRecipients(options.to, 'to')
  if (to.length === 0) fail('to needs at least one address.')

  return {
    from:
      options.from === undefined
        ? defaults.from
        : parseAddress(options.from, 'from'),
    to,
    cc: parseRecipients(options.cc, 'cc'),
    bcc: parseRecipients(options.bcc, 'bcc'),
    replyTo:
      options.replyTo === undefined
        ? defaults.replyTo
        : parseRecipients(options.replyTo, 'replyTo'),
    attachments: parseAttachments(options.attachments),
    headers: parseHeaders(options.headers),
    tags: parseTags(options.tags),
    metadata: parseMetadata(options.metadata),
  }
}

/** Rejects unknown options. */
export const checkKeys = (
  label: string,
  options: unknown,
  allowed: ReadonlySet<string>
): Record<string, unknown> => {
  if (!isRecord(options)) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  return options
}

/**
 * Address as a header value: `"Ada Lovelace" <ada@example.com>`, or the
 * address alone. For providers that take strings.
 */
export const formatAddress = ({ name, address }: Address) =>
  name ? `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>` : address
