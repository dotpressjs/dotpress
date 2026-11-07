import { malformedBodyError, unsupportedMediaTypeError } from './errors.js'
import type { QueryValues } from './http.js'

/**
 * Default maximum size of a request body read by adapters: 1 MiB.
 */
export const DEFAULT_BODY_LIMIT = 1024 * 1024

/**
 * Parses a query string (with or without the leading `?`). Repeated keys
 * produce arrays, and `+` is decoded as a space.
 */
export const parseQueryString = (search: string): QueryValues => {
  const params = new URLSearchParams(search)
  const query: QueryValues = {}

  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)
    query[key] = values.length === 1 ? values[0]! : values
  }

  return query
}

interface ContentType {
  /** Lowercase media type, without parameters. */
  readonly type: string
  readonly charset: string | undefined
}

const parseContentType = (header: string | undefined): ContentType => {
  if (header === undefined) {
    return { type: '', charset: undefined }
  }

  const [type = '', ...parameters] = header.split(';')
  let charset: string | undefined

  for (const parameter of parameters) {
    const [name, value] = parameter.split('=')
    if (name?.trim().toLowerCase() === 'charset' && value !== undefined) {
      charset = value.trim().replace(/^"(.*)"$/, '$1')
    }
  }

  return { type: type.trim().toLowerCase(), charset }
}

const isJsonType = (type: string) =>
  type === 'application/json' || type.endsWith('+json')

const decodeUtf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Parses a raw request body according to its `Content-Type`:
 *
 * - empty body: `undefined`
 * - `application/json`, `*+json`: parsed JSON (UTF-8)
 * - `application/x-www-form-urlencoded`: record of strings, like the query
 * - `text/*`: string, decoded with the declared charset (UTF-8 by default)
 * - anything else: the raw bytes
 *
 * Throws `MALFORMED_BODY` (400) for invalid JSON or UTF-8, and
 * `UNSUPPORTED_MEDIA_TYPE` (415) for unknown charsets.
 */
export const parseRequestBody = (
  bytes: Uint8Array,
  contentTypeHeader: string | undefined
): unknown => {
  if (bytes.byteLength === 0) {
    return undefined
  }

  const { type, charset } = parseContentType(contentTypeHeader)

  if (isJsonType(type)) {
    const text = decodeUtf8(bytes)
    if (text === undefined) throw malformedBodyError()

    try {
      return JSON.parse(text) as unknown
    } catch {
      throw malformedBodyError()
    }
  }

  if (type === 'application/x-www-form-urlencoded') {
    const text = decodeUtf8(bytes)
    if (text === undefined) throw malformedBodyError()
    return parseQueryString(text)
  }

  if (type.startsWith('text/')) {
    let decoder: TextDecoder
    try {
      decoder = new TextDecoder(charset ?? 'utf-8')
    } catch {
      throw unsupportedMediaTypeError(`Unsupported charset "${charset}"`)
    }
    return decoder.decode(bytes)
  }

  return bytes
}
