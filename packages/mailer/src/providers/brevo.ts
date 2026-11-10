import { base64 } from '../encoding.js'
import { MailMessageError } from '../errors.js'
import type { MailProvider } from '../mailer.js'
import type { Address, MailMessage } from '../message.js'
import {
  checkHttpOptions,
  checkNoInline,
  checkSingleReplyTo,
  readJson,
  responseError,
  stringOf,
  type HttpProviderOptions,
} from './http.js'

/** Options of `createBrevoProvider()`. */
export interface BrevoProviderOptions extends HttpProviderOptions {
  /** API key (v3). */
  apiKey: string
  /** Base URL of the API. Defaults to `https://api.brevo.com`. */
  baseUrl?: string | undefined
}

const DEFAULT_BASE_URL = 'https://api.brevo.com'
const MAX_NAME_LENGTH = 70

// Attachment extensions accepted by the API.
const EXTENSIONS = new Set(
  'xlsx xls ods docx docm doc csv pdf txt gif jpg jpeg png tif tiff rtf bmp cgm css shtml html htm zip xml ppt pptx tar ez ics mobi msg pub eps odt mp3 m4a m4v wma ogg flac wav aif aifc aiff mp4 mov avi mkv mpeg mpg wmv pkpass xlsm'.split(
    ' '
  )
)

const fail = (message: string): never => {
  throw new MailMessageError(`Brevo ${message}`)
}

/** Checks the limits of the API. */
const checkLimits = (message: MailMessage) => {
  checkSingleReplyTo('Brevo', message.replyTo.length)
  checkNoInline('Brevo', message.attachments)
  const addresses = [
    message.from,
    ...message.to,
    ...message.cc,
    ...message.bcc,
    ...message.replyTo,
  ]
  const named = addresses.find(
    ({ name }) => name !== undefined && name.length > MAX_NAME_LENGTH
  )
  if (named) {
    fail(
      `accepts names of at most ${MAX_NAME_LENGTH} characters: "${named.name?.slice(0, 20)}…" (${named.address}).`
    )
  }
  for (const { filename } of message.attachments) {
    const extension = /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase()
    if (!EXTENSIONS.has(extension as string)) {
      fail(
        `does not accept this attachment type: ${filename} (see the extensions accepted by Brevo).`
      )
    }
  }
}

const toAddress = ({ name, address }: Address) =>
  name ? { email: address, name } : { email: address }

/** Body of the API, see https://developers.brevo.com/reference/sendtransacemail */
const toBody = (message: MailMessage) => {
  checkLimits(message)
  const { cc, bcc, replyTo, html, text, attachments, headers, tags } = message
  return {
    sender: toAddress(message.from),
    to: message.to.map(toAddress),
    ...(cc.length > 0 ? { cc: cc.map(toAddress) } : {}),
    ...(bcc.length > 0 ? { bcc: bcc.map(toAddress) } : {}),
    ...(replyTo.length > 0 ? { replyTo: toAddress(replyTo[0]!) } : {}),
    subject: message.subject,
    ...(html === undefined || html === '' ? {} : { htmlContent: html }),
    ...(text === '' ? {} : { textContent: text }),
    ...(attachments.length > 0
      ? {
          attachment: attachments.map(({ filename, content }) => ({
            name: filename,
            content: base64(content),
          })),
        }
      : {}),
    ...(Object.keys(headers).length > 0 ? { headers: { ...headers } } : {}),
    ...(tags.length > 0 ? { tags: [...tags] } : {}),
  }
}

/**
 * Creates a provider that sends transactional messages with the API of
 * [Brevo](https://www.brevo.com) (v3), through `fetch`: no dependency.
 *
 * ```ts
 * const provider = createBrevoProvider({ apiKey: process.env.BREVO_API_KEY! })
 * ```
 */
export const createBrevoProvider = (
  options: BrevoProviderOptions
): MailProvider => {
  const { values, baseUrl, fetch } = checkHttpOptions(
    'createBrevoProvider()',
    options,
    ['apiKey'],
    DEFAULT_BASE_URL
  )
  const url = `${baseUrl}/v3/smtp/email`

  return {
    name: 'brevo',
    send: async (message) => {
      const body = JSON.stringify(toBody(message))
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'api-key': values.apiKey,
        },
        body,
      })
      const result = await readJson(response)
      if (!response.ok) {
        const detail = stringOf(result, 'message')
        const code = stringOf(result, 'code')
        throw responseError(
          'brevo',
          response,
          detail && code ? `${code}: ${detail}` : detail
        )
      }
      return { messageId: stringOf(result, 'messageId') }
    },
  }
}
