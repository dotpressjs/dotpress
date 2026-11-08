import { parseCookieHeader } from './cookies.js'
import type {
  IncomingHeaders,
  NormalizedRequest,
  QueryValues,
  UploadedFiles,
} from './http.js'

/**
 * Request exposed to middlewares and handlers as `ctx.req`.
 *
 * In middlewares, `params`, `query`, `body` and `files` hold the raw values
 * received by the adapter. In handlers, they hold the values parsed by the
 * route schema.
 */
export interface DotpressRequest<
  TParams = Record<string, string>,
  TQuery = QueryValues,
  TBody = unknown,
  TFiles = UploadedFiles,
> {
  /** Uppercase HTTP method. */
  readonly method: string
  /** Request path, without the query string. */
  readonly path: string
  /** Full request URL, when the adapter knows it. */
  readonly url: string | undefined
  readonly params: TParams
  readonly query: TQuery
  readonly body: TBody
  /** Files uploaded with a `multipart/form-data` body (empty otherwise). */
  readonly files: TFiles
  /** Request headers, with lowercase names. Repeated values are joined. */
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly cookies: Readonly<Record<string, string>>
  /**
   * Client IP address, as determined by the HTTP server. Proxy headers
   * (`X-Forwarded-For`) are only used when the server trusts them, for
   * instance with the Express `trust proxy` setting.
   */
  readonly ip: string | undefined
  /**
   * Raw bytes of the body, for instance to verify a webhook signature.
   * Only defined on routes declared with `rawBody: true` (empty when the
   * request has no body).
   */
  readonly rawBody: Uint8Array | undefined
  /**
   * Aborted when the client disconnects. Pass it to long-running work
   * (database queries, `fetch()` calls, streams) to stop it early.
   */
  readonly signal: AbortSignal
  /** Returns a header value (case-insensitive). */
  header(name: string): string | undefined
}

/**
 * Internal mutable view of the request, used to store parsed values.
 */
export interface MutableRequest extends DotpressRequest {
  params: Record<string, string>
  query: QueryValues
  body: unknown
  files: UploadedFiles
}

const normalizeHeaders = (
  headers: IncomingHeaders
): Record<string, string | undefined> => {
  const result: Record<string, string | undefined> = {}

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const key = name.toLowerCase()
    const joined = Array.isArray(value) ? value.join(', ') : value
    result[key] =
      result[key] === undefined ? joined : `${result[key]}, ${joined}`
  }

  return result
}

// Signal for adapters that cannot detect disconnections: it never aborts.
const NEVER_ABORTED = new AbortController().signal

const EMPTY_BODY = new Uint8Array(0)

const resolveRawBody = (input: NormalizedRequest): Uint8Array => {
  if (input.rawBody !== undefined) return input.rawBody
  if (input.body === undefined) return EMPTY_BODY

  throw new Error(
    'The raw request body is not available: it was probably read by a native middleware of the HTTP server before Dotpress.'
  )
}

export interface CreateRequestOptions {
  /** Exposes the raw body (`rawBody: true` routes). */
  readonly rawBody?: boolean
}

export const createRequest = (
  input: NormalizedRequest,
  options: CreateRequestOptions = {}
): MutableRequest => {
  const headers = normalizeHeaders(input.headers)

  return {
    method: input.method.toUpperCase(),
    path: input.path,
    url: input.url,
    params: { ...input.params },
    query: { ...input.query },
    body: input.body,
    files: { ...input.files },
    headers,
    cookies: parseCookieHeader(headers.cookie),
    ip: input.ip,
    signal: input.signal ?? NEVER_ABORTED,
    rawBody: options.rawBody ? resolveRawBody(input) : undefined,
    header: (name) => headers[name.toLowerCase()],
  }
}
