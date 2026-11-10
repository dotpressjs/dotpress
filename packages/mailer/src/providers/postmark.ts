import { base64 } from '../encoding.js'
import { MailMessageError } from '../errors.js'
import type { MailProvider } from '../mailer.js'
import { formatAddress, type Address, type MailMessage } from '../message.js'
import {
  checkHttpOptions,
  jsonBody,
  readJson,
  responseError,
  stringOf,
  type HttpProviderOptions,
} from './http.js'

/** Options of `createPostmarkProvider()`. */
export interface PostmarkProviderOptions extends HttpProviderOptions {
  /** Server API token. `POSTMARK_API_TEST` sends nothing (test mode). */
  serverToken: string
  /** Message stream. Defaults to the transactional stream (`outbound`). */
  messageStream?: string | undefined
  /** Base URL of the API. Defaults to `https://api.postmarkapp.com`. */
  baseUrl?: string | undefined
}

const DEFAULT_BASE_URL = 'https://api.postmarkapp.com'

// Limits of the Email API.
const MAX_RECIPIENTS = 50
const MAX_ADDRESS_LENGTH = 254
const MAX_FROM_LENGTH = 255
const MAX_SUBJECT_LENGTH = 2000
const MAX_REQUEST_BYTES = 10_000_000
const FORBIDDEN_EXTENSIONS = new Set(
  'vbs exe bin bat chm com cpl crt hlp hta inf ins isp jse lnk mdb pcd pif reg scr sct shs vbe vba wsf wsh wsl msc msi msp mst'.split(
    ' '
  )
)

const fail = (message: string): never => {
  throw new MailMessageError(`Postmark ${message}`)
}

/** Checks the limits of the Email API. */
const checkLimits = (message: MailMessage) => {
  const recipients = [...message.to, ...message.cc, ...message.bcc]
  if (recipients.length > MAX_RECIPIENTS) {
    fail(
      `accepts at most ${MAX_RECIPIENTS} recipients (to, cc and bcc), got ${recipients.length}.`
    )
  }
  const long = [...recipients, ...message.replyTo].find(
    ({ address }) => address.length > MAX_ADDRESS_LENGTH
  )
  if (long) {
    fail(
      `accepts addresses of at most ${MAX_ADDRESS_LENGTH} characters: ${long.address.slice(0, 20)}… has ${long.address.length}.`
    )
  }
  if (formatAddress(message.from).length > MAX_FROM_LENGTH) {
    fail(`accepts a sender of at most ${MAX_FROM_LENGTH} characters.`)
  }
  if (message.subject.length > MAX_SUBJECT_LENGTH) {
    fail(
      `accepts subjects of at most ${MAX_SUBJECT_LENGTH} characters, got ${message.subject.length}.`
    )
  }
  if (message.tags.length > 1) {
    fail(`accepts a single tag, got ${message.tags.length}.`)
  }
  for (const { filename } of message.attachments) {
    const extension = /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase()
    if (extension && FORBIDDEN_EXTENSIONS.has(extension)) {
      fail(`does not accept .${extension} attachments (${filename}).`)
    }
  }
}

const list = (addresses: readonly Address[]) =>
  addresses.map(formatAddress).join(', ')

/** Body of the Email API, see https://postmarkapp.com/developer/api/email-api */
const toBody = (message: MailMessage, messageStream: string | undefined) => {
  checkLimits(message)
  const { cc, bcc, replyTo, html, text, attachments, headers } = message
  const [tag] = message.tags
  return {
    From: formatAddress(message.from),
    To: list(message.to),
    ...(cc.length > 0 ? { Cc: list(cc) } : {}),
    ...(bcc.length > 0 ? { Bcc: list(bcc) } : {}),
    ...(replyTo.length > 0 ? { ReplyTo: list(replyTo) } : {}),
    Subject: message.subject,
    ...(text === '' ? {} : { TextBody: text }),
    ...(html === undefined || html === '' ? {} : { HtmlBody: html }),
    ...(Object.keys(headers).length > 0
      ? {
          Headers: Object.entries(headers).map(([Name, Value]) => ({
            Name,
            Value,
          })),
        }
      : {}),
    ...(attachments.length > 0
      ? {
          Attachments: attachments.map(
            ({ filename, content, contentType, contentId }) => ({
              Name: filename,
              Content: base64(content),
              ContentType: contentType ?? 'application/octet-stream',
              ...(contentId === undefined
                ? {}
                : { ContentID: `cid:${contentId}` }),
            })
          ),
        }
      : {}),
    // Left out of the JSON when undefined.
    Tag: tag,
    ...(Object.keys(message.metadata).length > 0
      ? { Metadata: { ...message.metadata } }
      : {}),
    ...(messageStream === undefined ? {} : { MessageStream: messageStream }),
  }
}

/**
 * Creates a provider that sends messages with the Email API of
 * [Postmark](https://postmarkapp.com), through `fetch`: no dependency.
 *
 * ```ts
 * const provider = createPostmarkProvider({
 *   serverToken: process.env.POSTMARK_SERVER_TOKEN!,
 * })
 * ```
 */
export const createPostmarkProvider = (
  options: PostmarkProviderOptions
): MailProvider => {
  const { values, baseUrl, fetch } = checkHttpOptions(
    'createPostmarkProvider()',
    options,
    ['serverToken'],
    DEFAULT_BASE_URL,
    ['messageStream']
  )
  const { serverToken, messageStream } = values
  if (
    messageStream !== undefined &&
    (typeof messageStream !== 'string' || messageStream === '')
  ) {
    throw new TypeError(
      'createPostmarkProvider(): messageStream must be a non-empty string.'
    )
  }
  const url = `${baseUrl}/email`

  return {
    name: 'postmark',
    send: async (message) => {
      const body = jsonBody(
        'Postmark',
        toBody(message, messageStream as string | undefined),
        MAX_REQUEST_BYTES
      )
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-postmark-server-token': serverToken,
        },
        body,
      })
      const result = await readJson(response)
      if (!response.ok) {
        const detail = stringOf(result, 'Message')
        const code = (result as { ErrorCode?: unknown } | undefined)?.ErrorCode
        throw responseError(
          'postmark',
          response,
          detail && typeof code === 'number'
            ? `${detail} (ErrorCode ${code})`
            : detail
        )
      }
      return { messageId: stringOf(result, 'MessageID') }
    },
  }
}
