import { base64 } from '../encoding.js'
import { MailSendError } from '../errors.js'
import type { MailProvider } from '../mailer.js'
import { checkKeys, type Address, type MailMessage } from '../message.js'

/** Options of `createSendgridProvider()`. */
export interface SendgridProviderOptions {
  /** API key, with the Mail Send permission. */
  apiKey: string
  /**
   * Base URL of the API. Defaults to `https://api.sendgrid.com`; use
   * `https://api.eu.sendgrid.com` for EU regional subusers.
   */
  baseUrl?: string | undefined
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined
}

const OPTIONS = new Set(['apiKey', 'baseUrl', 'fetch'])
const DEFAULT_BASE_URL = 'https://api.sendgrid.com'

interface SendgridAddress {
  email: string
  name?: string
}

const toAddress = ({ name, address }: Address): SendgridAddress =>
  name ? { email: address, name } : { email: address }

/**
 * Body of the Mail Send API (v3), see
 * https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
 */
const toBody = (message: MailMessage) => {
  const { to, cc, bcc, replyTo, html, text, attachments, headers } = message
  return {
    personalizations: [
      {
        to: to.map(toAddress),
        ...(cc.length > 0 ? { cc: cc.map(toAddress) } : {}),
        ...(bcc.length > 0 ? { bcc: bcc.map(toAddress) } : {}),
      },
    ],
    from: toAddress(message.from),
    // reply_to and reply_to_list are mutually exclusive.
    ...(replyTo.length === 1 ? { reply_to: toAddress(replyTo[0]!) } : {}),
    ...(replyTo.length > 1 ? { reply_to_list: replyTo.map(toAddress) } : {}),
    subject: message.subject,
    // text/plain first; empty values are rejected by the API.
    content: [
      ...(text === '' ? [] : [{ type: 'text/plain', value: text }]),
      ...(html === undefined || html === ''
        ? []
        : [{ type: 'text/html', value: html }]),
    ],
    ...(attachments.length > 0
      ? {
          attachments: attachments.map(
            ({ filename, content, contentType, contentId }) => ({
              content: base64(content),
              filename,
              ...(contentType === undefined ? {} : { type: contentType }),
              ...(contentId === undefined
                ? { disposition: 'attachment' }
                : { disposition: 'inline', content_id: contentId }),
            })
          ),
        }
      : {}),
    ...(Object.keys(headers).length > 0 ? { headers: { ...headers } } : {}),
  }
}

/** Error messages of an API response, if any. */
const errorDetails = async (response: Response) => {
  const body = await response.text().catch(() => '')
  try {
    const { errors } = JSON.parse(body) as { errors?: unknown }
    if (Array.isArray(errors)) {
      const messages = errors
        .map((error) => (error as { message?: unknown } | null)?.message)
        .filter((message) => typeof message === 'string' && message !== '')
      if (messages.length > 0) return messages.join('; ')
    }
  } catch {
    // Not JSON: the status text is used.
  }
  return response.statusText
}

/**
 * Creates a provider that sends messages with the Mail Send API (v3) of
 * Twilio SendGrid, through `fetch`: no dependency.
 *
 * ```ts
 * const provider = createSendgridProvider({ apiKey: process.env.SENDGRID_API_KEY! })
 * ```
 */
export const createSendgridProvider = (
  options: SendgridProviderOptions
): MailProvider => {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchFn = globalThis.fetch,
  } = checkKeys(
    'createSendgridProvider()',
    options,
    OPTIONS
  ) as Partial<SendgridProviderOptions>
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new TypeError(
      'createSendgridProvider(): apiKey must be a non-empty string.'
    )
  }
  if (typeof baseUrl !== 'string' || !/^https?:\/\/[^/]/.test(baseUrl)) {
    throw new TypeError(
      'createSendgridProvider(): baseUrl must be an http(s) URL.'
    )
  }
  if (typeof fetchFn !== 'function') {
    throw new TypeError('createSendgridProvider(): fetch must be a function.')
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/v3/mail/send`

  return {
    name: 'sendgrid',
    send: async (message) => {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(toBody(message)),
      })
      if (!response.ok) {
        throw new MailSendError(
          'sendgrid',
          `${response.status} ${await errorDetails(response)}`.trim(),
          { status: response.status }
        )
      }
      // 202 Accepted, without body.
      await response.body?.cancel()
      return { messageId: response.headers.get('x-message-id') ?? undefined }
    },
  }
}
