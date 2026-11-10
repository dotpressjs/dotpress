import { base64, utf8 } from '../encoding.js'
import { MailMessageError } from '../errors.js'
import type { MailProvider } from '../mailer.js'
import type { Address, MailMessage } from '../message.js'
import {
  checkHttpOptions,
  jsonBody,
  readJson,
  responseError,
  stringOf,
  type HttpProviderOptions,
} from './http.js'

/** Options of `createSendgridProvider()`. */
export interface SendgridProviderOptions extends HttpProviderOptions {
  /** API key, with the Mail Send permission. */
  apiKey: string
  /**
   * Base URL of the API. Defaults to `https://api.sendgrid.com`; use
   * `https://api.eu.sendgrid.com` for EU regional subusers.
   */
  baseUrl?: string | undefined
}

const DEFAULT_BASE_URL = 'https://api.sendgrid.com'

interface SendgridAddress {
  email: string
  name?: string
}

const toAddress = ({ name, address }: Address): SendgridAddress =>
  name ? { email: address, name } : { email: address }

const MAX_CATEGORIES = 10
const MAX_CATEGORY_LENGTH = 255
const MAX_CUSTOM_ARGS_BYTES = 10_000
const MAX_REQUEST_BYTES = 30_000_000

/** Limits of the API on categories (tags) and custom_args (metadata). */
const checkTags = ({ tags, metadata }: MailMessage) => {
  if (tags.length > MAX_CATEGORIES) {
    throw new MailMessageError(
      `SendGrid accepts at most ${MAX_CATEGORIES} tags (categories), got ${tags.length}.`
    )
  }
  const long = tags.find((tag) => tag.length > MAX_CATEGORY_LENGTH)
  if (long !== undefined) {
    throw new MailMessageError(
      `SendGrid accepts tags (categories) of at most ${MAX_CATEGORY_LENGTH} characters: "${long.slice(0, 20)}…" has ${long.length}.`
    )
  }
  const size = utf8(JSON.stringify(metadata)).byteLength
  if (size > MAX_CUSTOM_ARGS_BYTES) {
    throw new MailMessageError(
      `SendGrid accepts at most ${MAX_CUSTOM_ARGS_BYTES} bytes of metadata (custom_args), got ${size}.`
    )
  }
  return { tags, metadata }
}

/**
 * Body of the Mail Send API (v3), see
 * https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
 */
const toBody = (message: MailMessage) => {
  const { to, cc, bcc, replyTo, html, text, attachments, headers } = message
  const { tags, metadata } = checkTags(message)
  return {
    personalizations: [
      {
        to: to.map(toAddress),
        ...(cc.length > 0 ? { cc: cc.map(toAddress) } : {}),
        ...(bcc.length > 0 ? { bcc: bcc.map(toAddress) } : {}),
        ...(Object.keys(metadata).length > 0
          ? { custom_args: { ...metadata } }
          : {}),
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
    ...(tags.length > 0 ? { categories: [...tags] } : {}),
  }
}

/** Error messages of an API response (`errors[].message`), if any. */
const errorDetail = (body: unknown) => {
  const { errors } = (body ?? {}) as { errors?: unknown }
  if (!Array.isArray(errors)) return undefined
  const messages = errors
    .map((error) => stringOf(error, 'message'))
    .filter((message) => message !== undefined)
  return messages.length > 0 ? messages.join('; ') : undefined
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
  const { values, baseUrl, fetch } = checkHttpOptions(
    'createSendgridProvider()',
    options,
    ['apiKey'],
    DEFAULT_BASE_URL
  )
  const { apiKey } = values
  const url = `${baseUrl}/v3/mail/send`

  return {
    name: 'sendgrid',
    send: async (message) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        // 30 MB per message, attachments included.
        body: jsonBody('SendGrid', toBody(message), MAX_REQUEST_BYTES),
      })
      if (!response.ok) {
        throw responseError(
          'sendgrid',
          response,
          errorDetail(await readJson(response))
        )
      }
      // 202 Accepted, without body.
      await response.body?.cancel()
      return { messageId: response.headers.get('x-message-id') ?? undefined }
    },
  }
}
