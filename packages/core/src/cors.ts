import type {
  HttpMethod,
  IncomingHeaders,
  NormalizedRequest,
  NormalizedResponse,
  ResponseHeaders,
} from './http.js'
import type { Logger } from './logger.js'

/**
 * Allowed origins: `'*'` (any origin, without credentials), an origin
 * (`'https://app.example.com'`), a regular expression, a list of origins
 * and regular expressions, or a function.
 */
export type CorsOrigin =
  | string
  | RegExp
  | readonly (string | RegExp)[]
  | ((origin: string, request: NormalizedRequest) => boolean | Promise<boolean>)

/** `cors` option of `createApp()`. */
export interface CorsOptions {
  /** Allowed origins. */
  origin: CorsOrigin
  /**
   * Allows credentials: cookies, and `fetch()` calls with
   * `credentials: 'include'`. Cannot be combined with `origin: '*'`.
   * Defaults to `false`.
   */
  credentials?: boolean
  /**
   * Request headers allowed by preflight responses. Defaults to the headers
   * requested by the browser (`Access-Control-Request-Headers`).
   */
  allowedHeaders?: readonly string[]
  /**
   * Response headers readable by the browser, besides the CORS-safelisted
   * ones (`Access-Control-Expose-Headers`). Defaults to none.
   */
  exposedHeaders?: readonly string[]
  /** How long browsers may cache preflight responses, in seconds. */
  maxAge?: number
}

/** CORS policy of an app, applied by the pipeline. */
export interface CorsPolicy {
  /**
   * Response to a preflight request from an allowed origin, for a path
   * with routes. Undefined otherwise: the request is handled as usual.
   */
  preflight(
    request: NormalizedRequest,
    allowedMethods: (path: string) => readonly HttpMethod[]
  ): Promise<NormalizedResponse | undefined>
  /** Adds the CORS headers to a response. */
  apply(
    request: NormalizedRequest,
    response: NormalizedResponse
  ): Promise<NormalizedResponse>
}

const OPTIONS = new Set([
  'origin',
  'credentials',
  'allowedHeaders',
  'exposedHeaders',
  'maxAge',
])

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

const fail = (message: string): never => {
  throw new TypeError(`Invalid cors option: ${message}`)
}

const checkOrigin = (origin: string) => {
  let parsed: string | undefined
  try {
    parsed = new URL(origin).origin
  } catch {
    // Reported below.
  }
  if (parsed !== origin) {
    fail(
      `"${origin}" is not an origin: expected "scheme://host[:port]" in lowercase, without path or trailing slash.`
    )
  }
}

const checkHeaders = (name: string, headers: unknown) => {
  if (
    !Array.isArray(headers) ||
    !headers.every((header) => typeof header === 'string' && TOKEN.test(header))
  ) {
    fail(`${name} must be a list of header names.`)
  }
}

type OriginCheck = (
  origin: string,
  request: NormalizedRequest
) => boolean | Promise<boolean>

const toOriginCheck = (origin: unknown): OriginCheck => {
  if (typeof origin === 'function') return origin as OriginCheck

  const list: unknown[] = Array.isArray(origin) ? origin : [origin]
  if (origin === undefined || list.length === 0) {
    fail('origin is required.')
  }

  const origins = new Set<string>()
  const patterns: RegExp[] = []
  for (const item of list) {
    if (item instanceof RegExp) {
      patterns.push(item)
    } else if (typeof item === 'string') {
      checkOrigin(item)
      origins.add(item)
    } else {
      fail('origin must be "*", an origin, a RegExp, a list, or a function.')
    }
  }

  return (value) =>
    origins.has(value) ||
    patterns.some((pattern) => {
      pattern.lastIndex = 0
      return pattern.test(value)
    })
}

const headerOf = (headers: IncomingHeaders, name: string) => {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Adds tokens to the `Vary` header. */
const vary = (headers: ResponseHeaders, ...names: string[]) => {
  const current = headers.vary
  const values = (Array.isArray(current) ? current.join(',') : (current ?? ''))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.includes('*')) return

  const lower = new Set(values.map((value) => value.toLowerCase()))
  for (const name of names) {
    if (!lower.has(name.toLowerCase())) values.push(name)
  }
  headers.vary = values.join(', ')
}

/**
 * Validates the `cors` option and creates the policy. Failures of the
 * `origin` function are logged, and the origin is refused.
 */
export const createCorsPolicy = (
  options: CorsOptions,
  logger: Logger
): CorsPolicy => {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    fail('expected an object.')
  }
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key)) fail(`unknown option "${key}".`)
  }

  const {
    origin,
    credentials = false,
    allowedHeaders,
    exposedHeaders = [],
    maxAge,
  } = options
  const any = origin === '*'

  if (typeof credentials !== 'boolean') fail('credentials must be a boolean.')
  if (any && credentials) {
    fail(
      'origin "*" cannot be combined with credentials: list the allowed origins.'
    )
  }
  if (allowedHeaders !== undefined) {
    checkHeaders('allowedHeaders', allowedHeaders)
  }
  checkHeaders('exposedHeaders', exposedHeaders)
  if (maxAge !== undefined && (!Number.isInteger(maxAge) || maxAge < 0)) {
    fail('maxAge must be a non-negative integer (seconds).')
  }

  const check = any ? () => true : toOriginCheck(origin)

  /** Allowed origin of the request, if any. */
  const allowedOrigin = async (request: NormalizedRequest) => {
    const value = headerOf(request.headers, 'origin')
    if (value === undefined) return undefined
    try {
      return (await check(value, request)) === true ? value : undefined
    } catch (error) {
      logger.error(
        error instanceof Error ? error : { error },
        'CORS origin check failed'
      )
      return undefined
    }
  }

  /** Headers of every response from an allowed origin. */
  const originHeaders = (headers: ResponseHeaders, value: string) => {
    headers['access-control-allow-origin'] = any ? '*' : value
    if (credentials) headers['access-control-allow-credentials'] = 'true'
  }

  return {
    preflight: async (request, allowedMethods) => {
      if (request.method.toUpperCase() !== 'OPTIONS') return undefined
      const requested = headerOf(
        request.headers,
        'access-control-request-method'
      )
      if (requested === undefined) return undefined

      const value = await allowedOrigin(request)
      if (value === undefined) return undefined
      const methods = allowedMethods(request.path)
      if (methods.length === 0) return undefined

      const headers: ResponseHeaders = {}
      originHeaders(headers, value)
      headers['access-control-allow-methods'] = methods
        .map((method) => method.toUpperCase())
        .join(', ')

      const requestedHeaders = headerOf(
        request.headers,
        'access-control-request-headers'
      )
      const allowed = allowedHeaders?.join(', ') ?? requestedHeaders
      if (allowed) headers['access-control-allow-headers'] = allowed
      if (maxAge !== undefined) {
        headers['access-control-max-age'] = String(maxAge)
      }

      const varies = any ? [] : ['Origin']
      if (allowedHeaders === undefined) {
        varies.push('Access-Control-Request-Headers')
      }
      if (varies.length > 0) vary(headers, ...varies)

      return { status: 204, headers, body: null, kind: 'empty' }
    },

    apply: async (request, response) => {
      const headers = { ...response.headers }
      const value = any ? '*' : await allowedOrigin(request)

      // The response depends on the origin: caches must not mix them up.
      if (!any) vary(headers, 'Origin')
      if (value !== undefined) {
        originHeaders(headers, value)
        if (exposedHeaders.length > 0) {
          headers['access-control-expose-headers'] = exposedHeaders.join(', ')
        }
      }
      return { ...response, headers }
    },
  }
}
