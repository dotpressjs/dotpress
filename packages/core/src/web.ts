import { parseQueryString, parseRequestBody, type ParsedBody } from './body.js'
import { payloadTooLargeError, unsupportedMediaTypeError } from './errors.js'
import type {
  IncomingHeaders,
  NormalizedRequest,
  NormalizedResponse,
} from './http.js'

/*
 * Helpers for adapters built on the Web `Request` and `Response` (Hono,
 * Bun, Deno, Workers, tests). They follow the rules of the adapter
 * contract (see `HttpAdapter`).
 */

export interface WebRequestOptions {
  /** Client IP address. */
  ip?: string
  /** Defaults to the signal of the request. */
  signal?: AbortSignal
  /** Native request object of the adapter. Defaults to the request. */
  raw?: unknown
}

/**
 * Converts the headers of a Web request. Names are lowercase, and repeated
 * headers are combined (`, `), as `Headers` does.
 */
export const fromWebHeaders = (headers: Headers): IncomingHeaders => {
  const result: IncomingHeaders = {}
  for (const [name, value] of headers) result[name] = value
  return result
}

/**
 * Normalizes a Web request, without its body (see `readRequestBody()`).
 * `params` is empty: the adapter sets it once the route is matched.
 */
export const fromWebRequest = (
  request: Request,
  options: WebRequestOptions = {}
): NormalizedRequest => {
  const url = new URL(request.url)
  return {
    method: request.method,
    path: url.pathname,
    url: request.url,
    params: {},
    query: parseQueryString(url.search),
    headers: fromWebHeaders(request.headers),
    body: undefined,
    signal: options.signal ?? request.signal,
    ip: options.ip,
    raw: options.raw ?? request,
  }
}

export interface RequestBody extends ParsedBody {
  /** Raw bytes of the body (`undefined` when there is none). */
  readonly rawBody: Uint8Array | undefined
}

const NO_BODY: RequestBody = {
  body: undefined,
  files: undefined,
  rawBody: undefined,
}

/**
 * Reads and parses the body of a Web request (see `parseRequestBody()`).
 *
 * Throws `PAYLOAD_TOO_LARGE` (413) beyond `limit` bytes, declared or read,
 * and `UNSUPPORTED_MEDIA_TYPE` (415) for a `Content-Encoding` other than
 * `identity`. The rest of the body is then cancelled.
 */
export const readRequestBody = async (
  request: Request,
  limit: number
): Promise<RequestBody> => {
  if (request.body === null) return NO_BODY

  const encoding = (request.headers.get('content-encoding') ?? 'identity')
    // `Headers` trims the values.
    .toLowerCase()
  if (encoding !== 'identity') {
    await request.body.cancel()
    throw unsupportedMediaTypeError(
      `Unsupported content encoding "${encoding}"`
    )
  }

  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await request.body.cancel()
    throw payloadTooLargeError()
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw payloadTooLargeError()
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  const parsed = await parseRequestBody(
    bytes,
    request.headers.get('content-type') ?? undefined
  )
  return { ...parsed, rawBody: bytes }
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * Converts a normalized response into a Web response. The body of `HEAD`
 * requests and of null-body statuses (`204`, `304`…) is dropped (a stream
 * is cancelled).
 */
export const toWebResponse = async (
  response: NormalizedResponse,
  method: string
): Promise<Response> => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item)
    }
  }

  let body = response.body
  if (
    method.toUpperCase() === 'HEAD' ||
    NULL_BODY_STATUSES.has(response.status)
  ) {
    if (body instanceof ReadableStream) await body.cancel().catch(() => {})
    body = null
  }

  return new Response(body as BodyInit | null, {
    status: response.status,
    headers,
  })
}
