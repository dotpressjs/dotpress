import { base64, utf8 } from '../encoding.js'
import { MailMessageError } from '../errors.js'
import type { MailProvider } from '../mailer.js'
import { formatAddress, type MailMessage } from '../message.js'
import {
  checkHttpOptions,
  readJson,
  responseError,
  stringOf,
  type HttpProviderOptions,
} from './http.js'

/** Options of `createMailgunProvider()`. */
export interface MailgunProviderOptions extends HttpProviderOptions {
  /** API key, or a sending key of the domain. */
  apiKey: string
  /** Sending domain, like `mg.example.com`. */
  domain: string
  /**
   * Base URL of the API. Defaults to `https://api.mailgun.net`; use
   * `https://api.eu.mailgun.net` for a domain created in the EU region.
   */
  baseUrl?: string | undefined
}

const DEFAULT_BASE_URL = 'https://api.mailgun.net'
// Total size of the o:, h:, v: and t: options.
const MAX_OPTIONS_BYTES = 16 * 1024

/** Form data of the API, see https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages */
const toForm = (message: MailMessage) => {
  const form = new FormData()
  const options: [string, string][] = []

  form.append('from', formatAddress(message.from))
  // One field per address: names may contain commas.
  for (const [field, addresses] of [
    ['to', message.to],
    ['cc', message.cc],
    ['bcc', message.bcc],
  ] as const) {
    for (const address of addresses) form.append(field, formatAddress(address))
  }
  form.append('subject', message.subject)
  if (message.text !== '') form.append('text', message.text)
  if (message.html !== undefined && message.html !== '') {
    form.append('html', message.html)
  }

  if (message.replyTo.length > 0) {
    options.push(['h:Reply-To', message.replyTo.map(formatAddress).join(', ')])
  }
  for (const [name, value] of Object.entries(message.headers)) {
    options.push([`h:${name}`, value])
  }
  for (const tag of message.tags) options.push(['o:tag', tag])
  for (const [key, value] of Object.entries(message.metadata)) {
    options.push([`v:${key}`, value])
  }
  const size = options.reduce(
    (total, [name, value]) =>
      total + utf8(name).byteLength + utf8(value).byteLength,
    0
  )
  if (size > MAX_OPTIONS_BYTES) {
    throw new MailMessageError(
      `Mailgun accepts at most ${MAX_OPTIONS_BYTES} bytes of headers, tags and metadata, got ${size}.`
    )
  }
  for (const [name, value] of options) form.append(name, value)

  for (const {
    filename,
    content,
    contentType,
    contentId,
  } of message.attachments) {
    const blob = new Blob(
      // A copy: Blob takes ArrayBuffer views only (not shared buffers).
      [typeof content === 'string' ? utf8(content) : new Uint8Array(content)],
      contentType === undefined ? {} : { type: contentType }
    )
    // Inline images are referenced by their file name: cid:<contentId>.
    if (contentId === undefined) form.append('attachment', blob, filename)
    else form.append('inline', blob, contentId)
  }
  return form
}

/**
 * Creates a provider that sends messages with the API of
 * [Mailgun](https://www.mailgun.com), through `fetch`: no dependency.
 *
 * ```ts
 * const provider = createMailgunProvider({
 *   apiKey: process.env.MAILGUN_API_KEY!,
 *   domain: 'mg.example.com',
 * })
 * ```
 */
export const createMailgunProvider = (
  options: MailgunProviderOptions
): MailProvider => {
  const { values, baseUrl, fetch } = checkHttpOptions(
    'createMailgunProvider()',
    options,
    ['apiKey', 'domain'],
    DEFAULT_BASE_URL
  )
  const url = `${baseUrl}/v3/${encodeURIComponent(values.domain)}/messages`
  const authorization = `Basic ${base64(`api:${values.apiKey}`)}`

  return {
    name: 'mailgun',
    send: async (message) => {
      const body = toForm(message)
      // The content type (with its boundary) is set by fetch.
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization },
        body,
      })
      const result = await readJson(response)
      if (!response.ok) {
        throw responseError('mailgun', response, stringOf(result, 'message'))
      }
      return { messageId: stringOf(result, 'id') }
    },
  }
}
