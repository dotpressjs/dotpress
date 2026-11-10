import { base64 } from '../encoding.js'
import { MailMessageError } from '../errors.js'
import type { MailProvider } from '../mailer.js'
import { formatAddress, type Address, type MailMessage } from '../message.js'
import {
  checkHttpOptions,
  checkNoInline,
  readJson,
  responseError,
  stringOf,
  type HttpProviderOptions,
} from './http.js'

/** Options of `createScalewayProvider()`. */
export interface ScalewayProviderOptions extends HttpProviderOptions {
  /** Secret key of an API key with access to Transactional Email. */
  secretKey: string
  /** ID of the Project of the sending domain. */
  projectId: string
  /** Region of the sending domain. Defaults to `fr-par`. */
  region?: string | undefined
  /** Base URL of the API. Defaults to `https://api.scaleway.com`. */
  baseUrl?: string | undefined
}

const DEFAULT_BASE_URL = 'https://api.scaleway.com'
const DEFAULT_REGION = 'fr-par'
const MAX_SUBJECT_LENGTH = 998

const toAddress = ({ name, address }: Address) =>
  name ? { email: address, name } : { email: address }

/** Checks the limits of the API. */
const checkLimits = (message: MailMessage) => {
  checkNoInline('Scaleway', message.attachments)
  if (message.subject.length > MAX_SUBJECT_LENGTH) {
    throw new MailMessageError(
      `Scaleway accepts subjects of at most ${MAX_SUBJECT_LENGTH} characters, got ${message.subject.length}.`
    )
  }
  const empty = Object.entries(message.headers).find(
    ([, value]) => value === ''
  )
  if (empty) {
    throw new MailMessageError(
      `Scaleway does not accept empty header values (${empty[0]}).`
    )
  }
}

/**
 * Body of the Transactional Email API (v1alpha1), as serialized by the
 * official Scaleway SDK.
 */
const toBody = (message: MailMessage, projectId: string) => {
  checkLimits(message)
  const { cc, bcc, replyTo, attachments } = message
  // No Reply-To field: it is an additional header.
  const headers = [
    ...(replyTo.length > 0
      ? [{ key: 'Reply-To', value: replyTo.map(formatAddress).join(', ') }]
      : []),
    ...Object.entries(message.headers).map(([key, value]) => ({ key, value })),
  ]
  return {
    from: toAddress(message.from),
    to: message.to.map(toAddress),
    ...(cc.length > 0 ? { cc: cc.map(toAddress) } : {}),
    ...(bcc.length > 0 ? { bcc: bcc.map(toAddress) } : {}),
    subject: message.subject,
    text: message.text,
    html: message.html ?? '',
    project_id: projectId,
    ...(attachments.length > 0
      ? {
          attachments: attachments.map(
            ({ filename, content, contentType }) => ({
              name: filename,
              type: contentType ?? 'application/octet-stream',
              content: base64(content),
            })
          ),
        }
      : {}),
    ...(headers.length > 0 ? { additional_headers: headers } : {}),
  }
}

/** Message of an API error, with its invalid fields. */
const errorDetail = (result: unknown) => {
  const message = stringOf(result, 'message')
  const fields = (result as { fields?: unknown } | undefined)?.fields
  if (message === undefined || typeof fields !== 'object' || fields === null) {
    return message
  }
  const details = Object.entries(fields)
    .filter(([, list]) => Array.isArray(list))
    .map(([name, list]) => `${name} (${(list as unknown[]).join(', ')})`)
  return details.length > 0 ? `${message}: ${details.join(', ')}` : message
}

/**
 * Creates a provider that sends messages with
 * [Scaleway Transactional Email](https://www.scaleway.com/en/transactional-email-tem/),
 * through `fetch`: no dependency.
 *
 * ```ts
 * const provider = createScalewayProvider({
 *   secretKey: process.env.SCW_SECRET_KEY!,
 *   projectId: process.env.SCW_DEFAULT_PROJECT_ID!,
 * })
 * ```
 */
export const createScalewayProvider = (
  options: ScalewayProviderOptions
): MailProvider => {
  const { values, baseUrl, fetch } = checkHttpOptions(
    'createScalewayProvider()',
    options,
    ['secretKey', 'projectId'],
    DEFAULT_BASE_URL,
    ['region']
  )
  const { region = DEFAULT_REGION } = values
  if (typeof region !== 'string' || !/^[a-z]{2}-[a-z]{3}$/.test(region)) {
    throw new TypeError(
      'createScalewayProvider(): region must be a Scaleway region, like fr-par.'
    )
  }
  const url = `${baseUrl}/transactional-email/v1alpha1/regions/${region}/emails`

  return {
    name: 'scaleway',
    send: async (message) => {
      const body = JSON.stringify(toBody(message, values.projectId))
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-auth-token': values.secretKey,
        },
        body,
      })
      const result = await readJson(response)
      if (!response.ok) {
        throw responseError('scaleway', response, errorDetail(result))
      }
      // One email per recipient: the first one identifies the message.
      const [email] =
        (result as { emails?: unknown[] } | undefined)?.emails ?? []
      return { messageId: stringOf(email, 'id') }
    },
  }
}
