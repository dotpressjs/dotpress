import { utf8 } from '../encoding.js'
import { MailMessageError, MailSendError } from '../errors.js'
import { checkKeys } from '../message.js'

/** Options shared by the providers based on an HTTP API. */
export interface HttpProviderOptions {
  /** Base URL of the API (region, proxy, tests). */
  baseUrl?: string | undefined
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined
}

/**
 * Checks the options of an HTTP provider: unknown options, required
 * strings, `baseUrl` and `fetch`. Throws a `TypeError` prefixed with
 * `label`, like `createPostmarkProvider()`.
 */
export const checkHttpOptions = <K extends string>(
  label: string,
  options: unknown,
  required: readonly K[],
  defaultBaseUrl: string,
  optional: readonly string[] = []
) => {
  const values = checkKeys(
    label,
    options,
    new Set<string>([...required, ...optional, 'baseUrl', 'fetch'])
  )
  for (const key of required) {
    const value = values[key]
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`${label}: ${key} must be a non-empty string.`)
    }
  }
  const { baseUrl = defaultBaseUrl, fetch: fetchFn = globalThis.fetch } = values
  if (typeof baseUrl !== 'string' || !/^https?:\/\/[^/]/.test(baseUrl)) {
    throw new TypeError(`${label}: baseUrl must be an http(s) URL.`)
  }
  if (typeof fetchFn !== 'function') {
    throw new TypeError(`${label}: fetch must be a function.`)
  }
  return {
    values: values as Record<K, string> & Record<string, unknown>,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    fetch: fetchFn as typeof fetch,
  }
}

/** JSON body of a response, or undefined (no body, not JSON). */
export const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text().catch(() => '')
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Send error of an API response: its status, and the message of the API
 * (`detail`) or the status text.
 */
export const responseError = (
  provider: string,
  response: Response,
  detail: string | undefined
) =>
  new MailSendError(
    provider,
    `${response.status} ${detail ?? response.statusText}`.trim(),
    { status: response.status }
  )

/** String property of a JSON value, if any. */
export const stringOf = (value: unknown, key: string) => {
  const property = (value as Record<string, unknown> | null | undefined)?.[key]
  return typeof property === 'string' && property !== '' ? property : undefined
}

/** Request body as JSON, checked against the size limit of the API. */
export const jsonBody = (provider: string, body: unknown, maxBytes: number) => {
  const json = JSON.stringify(body)
  const size = utf8(json).byteLength
  if (size > maxBytes) {
    throw new MailMessageError(
      `${provider} accepts requests of at most ${maxBytes / 1_000_000} MB, got ${(size / 1_000_000).toFixed(1)} MB (attachments are base64-encoded).`
    )
  }
  return json
}

/** Fails when a message has more reply-to addresses than the API accepts. */
export const checkSingleReplyTo = (provider: string, count: number) => {
  if (count > 1) {
    throw new MailMessageError(
      `${provider} accepts a single reply-to address, got ${count}.`
    )
  }
}

/** Fails when a message has inline attachments the API cannot send. */
export const checkNoInline = (
  provider: string,
  attachments: readonly { contentId?: string; filename: string }[]
) => {
  const inline = attachments.find(({ contentId }) => contentId !== undefined)
  if (inline) {
    throw new MailMessageError(
      `${provider} does not support inline attachments (${inline.filename} has a contentId).`
    )
  }
}
