import type { ResponseHeaders } from './http.js'
import type { SseMessage, StreamChunk, StreamSource } from './streaming.js'

const RESPONSE_RESULT_BRAND = Symbol.for('dotpress.ResponseResult')

export interface ResultInit {
  status?: number
  headers?: ResponseHeaders
}

interface BaseResult {
  readonly [RESPONSE_RESULT_BRAND]: true
  readonly init: ResultInit
}

export interface JsonResult<T = unknown> extends BaseResult {
  readonly kind: 'json'
  readonly data: T
}

export interface TextResult extends BaseResult {
  readonly kind: 'text'
  readonly body: string
}

export interface StreamResult extends BaseResult {
  readonly kind: 'stream'
  readonly source: StreamSource<StreamChunk>
}

export interface SseResult extends BaseResult {
  readonly kind: 'sse'
  readonly source: StreamSource<SseMessage>
  /** Heartbeat interval in milliseconds, or `false`. */
  readonly heartbeat: number | false
}

export interface FileResult extends BaseResult {
  readonly kind: 'file'
  readonly body: Uint8Array | ReadableStream<Uint8Array>
}

export interface RedirectResult extends BaseResult {
  readonly kind: 'redirect'
  readonly location: string
}

export interface EmptyResult extends BaseResult {
  readonly kind: 'empty'
}

/**
 * Value returned by the response helpers (`json()`, `text()`, `redirect()`,
 * `stream()`, `sse()`, `file()`, `empty()`).
 */
export type ResponseResult =
  | JsonResult
  | TextResult
  | StreamResult
  | SseResult
  | FileResult
  | RedirectResult
  | EmptyResult

/**
 * Response results that bypass response validation and filters.
 */
export type RawResult = Exclude<ResponseResult, JsonResult>

export const isResponseResult = (value: unknown): value is ResponseResult =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<symbol, unknown>)[RESPONSE_RESULT_BRAND] === true

const brand = <T extends { init: ResultInit }>(result: T): T & BaseResult =>
  Object.freeze({ [RESPONSE_RESULT_BRAND]: true as const, ...result })

/**
 * JSON response with an explicit status or headers. The data goes through
 * response validation and response filters, like a plain returned value.
 */
export const json = <T>(data: T, init: ResultInit = {}): JsonResult<T> =>
  brand({ kind: 'json' as const, data, init })

/**
 * Plain text response (`text/plain; charset=utf-8` by default).
 */
export const text = (body: string, init: ResultInit = {}): TextResult =>
  brand({ kind: 'text' as const, body, init })

export type RedirectStatus = 301 | 302 | 303 | 307 | 308

/** Options of `redirect()`. */
export interface RedirectInit {
  /** Defaults to `302 Found`. */
  status?: RedirectStatus | undefined
  headers?: ResponseHeaders | undefined
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
])

/**
 * Redirect response. Defaults to `302 Found`.
 *
 * @example
 * return redirect('/login')
 * return redirect('/new', { status: 301 })
 */
export const redirect = (
  location: string,
  init: RedirectInit = {}
): RedirectResult => {
  if (typeof init !== 'object' || init === null) {
    throw new TypeError(
      'redirect(): expected an options object, like { status: 301 }.'
    )
  }
  for (const key of Object.keys(init)) {
    if (key !== 'status' && key !== 'headers') {
      throw new TypeError(`redirect(): unknown option "${key}".`)
    }
  }
  const { status = 302, headers } = init
  if (!REDIRECT_STATUSES.has(status)) {
    throw new RangeError(
      `redirect(): status must be 301, 302, 303, 307 or 308, received ${status}.`
    )
  }
  return brand({
    kind: 'redirect' as const,
    location,
    init: { status, ...(headers === undefined ? {} : { headers }) },
  })
}

export interface StreamInit extends ResultInit {
  /** Defaults to `application/octet-stream`. */
  contentType?: string
}

/**
 * Streamed response. The source can be a `ReadableStream`, an iterable, an
 * async iterable, or a function returning one (typically an async generator
 * function, which receives the request abort signal). Chunks are strings
 * (encoded as UTF-8) or `Uint8Array` instances.
 *
 * @example
 * stream(async function* ({ signal }) {
 *   for await (const row of db.export({ signal })) yield `${row.csv}\n`
 * }, { contentType: 'text/csv' })
 */
export const stream = (
  source: StreamSource<StreamChunk> | StreamChunk,
  init: StreamInit = {}
): StreamResult => {
  const { contentType = 'application/octet-stream', ...rest } = init

  return brand({
    kind: 'stream' as const,
    // A string or a Uint8Array is a single chunk, not an iterable of chunks.
    source:
      typeof source === 'string' || source instanceof Uint8Array
        ? [source]
        : source,
    init: {
      ...rest,
      headers: { 'content-type': contentType, ...rest.headers },
    },
  })
}

export interface SseInit extends ResultInit {
  /**
   * Interval of the heartbeat comments that keep the connection open
   * through proxies, in milliseconds. Defaults to 15 seconds; `false`
   * disables it.
   */
  heartbeat?: number | false
}

const DEFAULT_SSE_HEARTBEAT = 15_000

/**
 * Server-Sent Events response. The source yields events (`{ data, event,
 * id, retry, comment }`) or strings sent as `data`. Non-string `data` is
 * serialized as JSON.
 *
 * Source functions receive the request abort signal: use it to stop
 * waiting for new events when the client disconnects.
 *
 * @example
 * sse(async function* ({ signal }) {
 *   for await (const order of orders.watch({ signal })) {
 *     yield { event: 'order', id: order.id, data: order }
 *   }
 * })
 */
export const sse = (
  source: StreamSource<SseMessage>,
  init: SseInit = {}
): SseResult => {
  const { heartbeat = DEFAULT_SSE_HEARTBEAT, ...rest } = init

  if (
    heartbeat !== false &&
    (typeof heartbeat !== 'number' ||
      !Number.isFinite(heartbeat) ||
      heartbeat <= 0)
  ) {
    throw new RangeError(
      'Invalid SSE heartbeat: expected a positive number of milliseconds or false.'
    )
  }

  return brand({
    kind: 'sse' as const,
    source,
    heartbeat,
    init: {
      ...rest,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        // Disables response buffering in nginx.
        'x-accel-buffering': 'no',
        ...rest.headers,
      },
    },
  })
}

export interface FileInit extends ResultInit {
  /** File name suggested to the client. */
  filename?: string
  /** Defaults to the Blob type, or `application/octet-stream`. */
  contentType?: string
  /** Defaults to `attachment`. */
  disposition?: 'attachment' | 'inline'
}

const encodeRfc5987 = (value: string) =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )

const contentDisposition = (
  disposition: 'attachment' | 'inline',
  filename: string | undefined
): string => {
  if (filename === undefined) {
    return disposition
  }

  // ASCII fallback for old clients, plus the RFC 5987 encoded name.
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`
}

/**
 * File download response.
 */
export const file = (
  body: Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
  init: FileInit = {}
): FileResult => {
  const { filename, contentType, disposition = 'attachment', ...rest } = init

  let payload: Uint8Array | ReadableStream<Uint8Array>
  let type = contentType

  if (body instanceof Blob) {
    payload = body.stream()
    type ??= body.type || undefined
  } else if (body instanceof ArrayBuffer) {
    payload = new Uint8Array(body)
  } else {
    payload = body
  }

  const headers: ResponseHeaders = {
    'content-type': type ?? 'application/octet-stream',
    'content-disposition': contentDisposition(disposition, filename),
  }

  if (body instanceof Blob) {
    headers['content-length'] = String(body.size)
  } else if (payload instanceof Uint8Array) {
    headers['content-length'] = String(payload.byteLength)
  }

  return brand({
    kind: 'file' as const,
    body: payload,
    init: { ...rest, headers: { ...headers, ...rest.headers } },
  })
}

/**
 * Response without a body. Defaults to `204 No Content`.
 */
export const empty = (init: ResultInit = {}): EmptyResult =>
  brand({ kind: 'empty' as const, init })
