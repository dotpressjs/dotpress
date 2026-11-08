import { malformedBodyError, unsupportedMediaTypeError } from './errors.js'
import type { QueryValues, UploadedFiles } from './http.js'

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

  // `Object.fromEntries()` defines own properties: a `__proto__` key cannot
  // change the prototype of the result.
  return Object.fromEntries(
    [...new Set(params.keys())].map((key) => {
      const values = params.getAll(key)
      return [key, values.length === 1 ? values[0]! : values]
    })
  )
}

const groupValues = <T>(entries: Iterable<[string, T]>) => {
  const groups = new Map<string, T[]>()
  for (const [key, value] of entries) {
    const group = groups.get(key)
    if (group) group.push(value)
    else groups.set(key, [value])
  }

  return Object.fromEntries(
    [...groups].map(([key, values]) => [
      key,
      values.length === 1 ? values[0]! : values,
    ])
  ) as Record<string, T | T[]>
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

export interface ParsedBody {
  /** Parsed body (`undefined` when there is none). */
  readonly body: unknown
  /** Uploaded files (`multipart/form-data` bodies only). */
  readonly files: UploadedFiles | undefined
}

const parseMultipart = async (
  bytes: Uint8Array,
  contentTypeHeader: string
): Promise<ParsedBody> => {
  let form: FormData
  try {
    // Request bodies are never backed by a SharedArrayBuffer.
    form = await new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: { 'content-type': contentTypeHeader },
    }).formData()
  } catch {
    throw malformedBodyError()
  }

  const fields: [string, string][] = []
  const files: [string, File][] = []

  for (const [name, value] of form) {
    if (typeof value === 'string') fields.push([name, value])
    else files.push([name, value])
  }

  return { body: groupValues(fields), files: groupValues(files) }
}

/**
 * Parses a raw request body according to its `Content-Type`:
 *
 * - empty body: `undefined`
 * - `application/json`, `*+json`: parsed JSON (UTF-8)
 * - `application/x-www-form-urlencoded`: record of strings, like the query
 * - `multipart/form-data`: text fields in `body` (like forms), files in
 *   `files` (Web `File` objects); repeated names produce arrays
 * - `text/*`: string, decoded with the declared charset (UTF-8 by default)
 * - anything else: the raw bytes
 *
 * Throws `MALFORMED_BODY` (400) for invalid JSON, UTF-8 or multipart
 * bodies, and `UNSUPPORTED_MEDIA_TYPE` (415) for unknown charsets.
 */
export const parseRequestBody = async (
  bytes: Uint8Array,
  contentTypeHeader: string | undefined
): Promise<ParsedBody> => {
  if (bytes.byteLength === 0) {
    return { body: undefined, files: undefined }
  }

  const { type, charset } = parseContentType(contentTypeHeader)

  if (isJsonType(type)) {
    const text = decodeUtf8(bytes)
    if (text === undefined) throw malformedBodyError()

    try {
      return { body: JSON.parse(text) as unknown, files: undefined }
    } catch {
      throw malformedBodyError()
    }
  }

  if (type === 'application/x-www-form-urlencoded') {
    const text = decodeUtf8(bytes)
    if (text === undefined) throw malformedBodyError()
    return { body: parseQueryString(text), files: undefined }
  }

  if (type === 'multipart/form-data') {
    return parseMultipart(bytes, contentTypeHeader!)
  }

  if (type.startsWith('text/')) {
    let decoder: TextDecoder
    try {
      decoder = new TextDecoder(charset ?? 'utf-8')
    } catch {
      throw unsupportedMediaTypeError(`Unsupported charset "${charset}"`)
    }
    return { body: decoder.decode(bytes), files: undefined }
  }

  return { body: bytes, files: undefined }
}
