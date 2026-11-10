import { base64 } from '../encoding.js'
import { MailSendError } from '../errors.js'
import type { MailProvider } from '../mailer.js'
import type { Address, MailMessage } from '../message.js'
import {
  checkHttpOptions,
  checkSingleReplyTo,
  jsonBody,
  readJson,
  responseError,
  stringOf,
  type HttpProviderOptions,
} from './http.js'

/** Options of `createMailjetProvider()`. */
export interface MailjetProviderOptions extends HttpProviderOptions {
  /** API key (public). */
  apiKey: string
  /** Secret key (private). */
  apiSecret: string
  /** Base URL of the API. Defaults to `https://api.mailjet.com`. */
  baseUrl?: string | undefined
}

const DEFAULT_BASE_URL = 'https://api.mailjet.com'
const MAX_REQUEST_BYTES = 15_000_000

const toAddress = ({ name, address }: Address) =>
  name ? { Email: address, Name: name } : { Email: address }

/** Body of the Send API v3.1, see https://dev.mailjet.com/email/reference/send-emails/ */
const toBody = (message: MailMessage) => {
  checkSingleReplyTo('Mailjet', message.replyTo.length)
  const { cc, bcc, replyTo, html, text, headers, metadata } = message
  const attachments = message.attachments.map(
    ({ filename, content, contentType, contentId }) => ({
      ContentType: contentType ?? 'application/octet-stream',
      Filename: filename,
      Base64Content: base64(content),
      ...(contentId === undefined ? {} : { ContentID: contentId }),
    })
  )
  const regular = attachments.filter((item) => !('ContentID' in item))
  const inline = attachments.filter((item) => 'ContentID' in item)
  return {
    Messages: [
      {
        From: toAddress(message.from),
        To: message.to.map(toAddress),
        ...(cc.length > 0 ? { Cc: cc.map(toAddress) } : {}),
        ...(bcc.length > 0 ? { Bcc: bcc.map(toAddress) } : {}),
        ...(replyTo.length > 0 ? { ReplyTo: toAddress(replyTo[0]!) } : {}),
        Subject: message.subject,
        ...(text === '' ? {} : { TextPart: text }),
        ...(html === undefined || html === '' ? {} : { HTMLPart: html }),
        ...(Object.keys(headers).length > 0 ? { Headers: { ...headers } } : {}),
        ...(regular.length > 0 ? { Attachments: regular } : {}),
        ...(inline.length > 0 ? { InlinedAttachments: inline } : {}),
        // Mailjet has no tags; metadata is returned by the event webhooks.
        ...(Object.keys(metadata).length > 0
          ? { EventPayload: JSON.stringify(metadata) }
          : {}),
      },
    ],
  }
}

interface MailjetError {
  ErrorMessage?: unknown
  StatusCode?: unknown
}

/** Errors of the response, at the message level or at the top level. */
const errorsOf = (result: unknown): string | undefined => {
  const [first] =
    (result as { Messages?: { Errors?: MailjetError[] }[] } | undefined)
      ?.Messages ?? []
  const messages = (first?.Errors ?? [])
    .map((error) => stringOf(error, 'ErrorMessage'))
    .filter((message) => message !== undefined)
  if (messages.length > 0) return messages.join('; ')
  return stringOf(result, 'ErrorMessage')
}

/** Identifier of the message for the first recipient of `to`. */
const messageIdOf = (result: unknown) => {
  const [first] =
    (
      result as
        | {
            Messages?: {
              To?: { MessageUUID?: unknown; MessageID?: unknown }[]
            }[]
          }
        | undefined
    )?.Messages ?? []
  const recipient = first?.To?.[0]
  if (typeof recipient?.MessageUUID === 'string') return recipient.MessageUUID
  return typeof recipient?.MessageID === 'number'
    ? String(recipient.MessageID)
    : undefined
}

/**
 * Creates a provider that sends messages with the Send API v3.1 of
 * [Mailjet](https://www.mailjet.com), through `fetch`: no dependency.
 *
 * ```ts
 * const provider = createMailjetProvider({
 *   apiKey: process.env.MAILJET_API_KEY!,
 *   apiSecret: process.env.MAILJET_API_SECRET!,
 * })
 * ```
 */
export const createMailjetProvider = (
  options: MailjetProviderOptions
): MailProvider => {
  const { values, baseUrl, fetch } = checkHttpOptions(
    'createMailjetProvider()',
    options,
    ['apiKey', 'apiSecret'],
    DEFAULT_BASE_URL
  )
  const url = `${baseUrl}/v3.1/send`
  const authorization = `Basic ${base64(`${values.apiKey}:${values.apiSecret}`)}`

  return {
    name: 'mailjet',
    send: async (message) => {
      const body = jsonBody('Mailjet', toBody(message), MAX_REQUEST_BYTES)
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body,
      })
      const result = await readJson(response)
      if (!response.ok) {
        throw responseError('mailjet', response, errorsOf(result))
      }
      const [first] =
        (
          result as
            | { Messages?: { Status?: unknown; Errors?: MailjetError[] }[] }
            | undefined
        )?.Messages ?? []
      // A message can fail in a successful response.
      if (first?.Status === 'error') {
        const code = first.Errors?.[0]?.StatusCode
        const status = typeof code === 'number' ? code : undefined
        throw new MailSendError(
          'mailjet',
          `${status ?? ''} ${errorsOf(result) ?? 'message rejected'}`.trim(),
          { status }
        )
      }
      return { messageId: messageIdOf(result) }
    },
  }
}
