import {
  Resend,
  type CreateEmailOptions,
  type CreateEmailResponse,
} from 'resend'
import { base64 } from '../encoding.js'
import { MailSendError } from '../errors.js'
import type { MailProvider } from '../mailer.js'
import { checkKeys, formatAddress, type MailMessage } from '../message.js'

/** A Resend client, or any object with the same `emails.send()` method. */
export interface ResendClient {
  emails: {
    send(payload: CreateEmailOptions): Promise<CreateEmailResponse>
  }
}

/** Options of `createResendProvider()`. */
export interface ResendProviderOptions {
  /** API key. Defaults to the `RESEND_API_KEY` environment variable. */
  apiKey?: string | undefined
  /** Base URL of the API, for the created client. */
  baseUrl?: string | undefined
  /** Existing client, instead of `apiKey` and `baseUrl`. */
  client?: ResendClient | undefined
}

const OPTIONS = new Set(['apiKey', 'baseUrl', 'client'])

const isNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value !== ''

/** Payload of the Resend API. */
const toPayload = (message: MailMessage): CreateEmailOptions => ({
  from: formatAddress(message.from),
  to: message.to.map(formatAddress),
  ...(message.cc.length > 0 ? { cc: message.cc.map(formatAddress) } : {}),
  ...(message.bcc.length > 0 ? { bcc: message.bcc.map(formatAddress) } : {}),
  ...(message.replyTo.length > 0
    ? { replyTo: message.replyTo.map(formatAddress) }
    : {}),
  subject: message.subject,
  text: message.text,
  ...(message.html === undefined ? {} : { html: message.html }),
  ...(message.attachments.length > 0
    ? {
        attachments: message.attachments.map(
          ({ filename, content, contentType, contentId }) => ({
            filename,
            // Base64 works with every version of the SDK.
            content: base64(content),
            ...(contentType === undefined ? {} : { contentType }),
            ...(contentId === undefined ? {} : { contentId }),
          })
        ),
      }
    : {}),
  ...(Object.keys(message.headers).length > 0
    ? { headers: { ...message.headers } }
    : {}),
})

/**
 * Creates a provider that sends messages with [Resend](https://resend.com),
 * through its SDK (`resend`, peer dependency).
 *
 * ```ts
 * const provider = createResendProvider({ apiKey: process.env.RESEND_API_KEY })
 * ```
 */
export const createResendProvider = (
  options: ResendProviderOptions = {}
): MailProvider => {
  const { apiKey, baseUrl, client } = checkKeys(
    'createResendProvider()',
    options,
    OPTIONS
  ) as ResendProviderOptions
  if (client !== undefined) {
    if (apiKey !== undefined || baseUrl !== undefined) {
      throw new TypeError(
        'createResendProvider(): set client, or apiKey and baseUrl, not both.'
      )
    }
    if (typeof client?.emails?.send !== 'function') {
      throw new TypeError(
        'createResendProvider(): client must have an emails.send() method.'
      )
    }
  }
  for (const [key, value] of [
    ['apiKey', apiKey],
    ['baseUrl', baseUrl],
  ] as const) {
    if (value !== undefined && !isNonEmptyString(value)) {
      throw new TypeError(
        `createResendProvider(): ${key} must be a non-empty string.`
      )
    }
  }

  const resend =
    client ??
    new Resend(apiKey, baseUrl === undefined ? undefined : { baseUrl })

  return {
    name: 'resend',
    send: async (message) => {
      const { data, error } = await resend.emails.send(toPayload(message))
      if (error) {
        throw new MailSendError('resend', `${error.name}: ${error.message}`, {
          status: error.statusCode ?? undefined,
          cause: error,
        })
      }
      return { messageId: data?.id }
    },
  }
}
