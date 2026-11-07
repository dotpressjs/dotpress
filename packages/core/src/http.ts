/**
 * HTTP methods supported by route definitions.
 */
export type HttpMethod =
  'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options'

export const HTTP_METHODS: readonly HttpMethod[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
]

export const isHttpMethod = (value: unknown): value is HttpMethod =>
  typeof value === 'string' && HTTP_METHODS.includes(value as HttpMethod)

/**
 * Header map used by normalized responses. Header names are lowercase.
 * `set-cookie` is the only header that is expected to hold several values.
 */
export type ResponseHeaders = Record<string, string | string[]>

/**
 * Header map received from adapters. Names should be lowercase; values may
 * be repeated.
 */
export type IncomingHeaders = Record<string, string | string[] | undefined>

/**
 * Query string values. Repeated keys produce arrays.
 */
export type QueryValues = Record<string, string | string[]>

/**
 * Body of a normalized response.
 * - `string`: serialized JSON or text
 * - `Uint8Array`: binary payload
 * - `ReadableStream`: streamed payload
 * - `null`: no body
 */
export type ResponseBody =
  string | Uint8Array | ReadableStream<Uint8Array> | null

export type ResponseKind =
  'json' | 'text' | 'stream' | 'file' | 'redirect' | 'empty'

/**
 * Framework-agnostic request handed by an adapter to the core.
 */
export interface NormalizedRequest {
  /** HTTP method, case-insensitive. */
  method: string
  /** Request path, without the query string. */
  path: string
  /** Full request URL, when the adapter knows it. */
  url?: string
  /** Path parameters extracted by the adapter's router. */
  params: Record<string, string>
  /** Parsed query string. */
  query: QueryValues
  /** Request headers, with lowercase names. */
  headers: IncomingHeaders
  /** Parsed request body (`undefined` when there is none). */
  body: unknown
  /**
   * Aborted when the client disconnects before the response is complete.
   * Adapters should provide it, and also cancel a streamed response body
   * when the client goes away.
   */
  signal?: AbortSignal
  /** Native request object of the adapter (escape hatch). */
  raw: unknown
}

/**
 * Framework-agnostic response produced by the core, serialized by adapters.
 */
export interface NormalizedResponse {
  status: number
  headers: ResponseHeaders
  body: ResponseBody
  kind: ResponseKind
}
