import { parseCookieHeader } from './cookies.js'
import type { IncomingHeaders, NormalizedRequest, QueryValues } from './http.js'

/**
 * Request exposed to middlewares and handlers as `ctx.req`.
 *
 * In middlewares, `params`, `query` and `body` hold the raw values received
 * by the adapter. In handlers, they hold the values parsed by the route
 * schema.
 */
export interface DotpressRequest<
  TParams = Record<string, string>,
  TQuery = QueryValues,
  TBody = unknown,
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
  /** Request headers, with lowercase names. Repeated values are joined. */
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly cookies: Readonly<Record<string, string>>
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

export const createRequest = (input: NormalizedRequest): MutableRequest => {
  const headers = normalizeHeaders(input.headers)

  return {
    method: input.method.toUpperCase(),
    path: input.path,
    url: input.url,
    params: { ...input.params },
    query: { ...input.query },
    body: input.body,
    headers,
    cookies: parseCookieHeader(headers.cookie),
    signal: input.signal ?? NEVER_ABORTED,
    header: (name) => headers[name.toLowerCase()],
  }
}
