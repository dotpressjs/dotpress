import { serializeCookie, type CookieOptions } from './cookies.js'
import type { ResponseHeaders } from './http.js'

/**
 * Response metadata exposed to middlewares and handlers as `ctx.res`.
 *
 * The body is never written through this object: handlers return a value or
 * a response helper instead.
 */
export interface DotpressResponse {
  /** Status set with `setStatus()`, if any. */
  readonly statusCode: number | undefined
  setStatus(status: number): this
  getHeader(name: string): string | string[] | undefined
  setHeader(name: string, value: string | string[]): this
  appendHeader(name: string, value: string | string[]): this
  removeHeader(name: string): this
  setCookie(name: string, value: string, options?: CookieOptions): this
  clearCookie(name: string, options?: CookieOptions): this
}

/**
 * Internal response state, collected during the request.
 */
export interface ResponseState extends DotpressResponse {
  /** Headers set on the response, including `set-cookie`. */
  toHeaders(): ResponseHeaders
}

const assertStatus = (status: number) => {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError(
      `Response status must be an integer between 100 and 599, received ${status}.`
    )
  }
}

const toArray = (value: string | string[]) =>
  Array.isArray(value) ? value : [value]

export const createResponseState = (): ResponseState => {
  let statusCode: number | undefined
  const headers = new Map<string, string[]>()

  const state: ResponseState = {
    get statusCode() {
      return statusCode
    },
    setStatus(status) {
      assertStatus(status)
      statusCode = status
      return state
    },
    getHeader(name) {
      const values = headers.get(name.toLowerCase())
      if (!values) return undefined
      return values.length === 1 ? values[0] : [...values]
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), [...toArray(value)])
      return state
    },
    appendHeader(name, value) {
      const key = name.toLowerCase()
      headers.set(key, [...(headers.get(key) ?? []), ...toArray(value)])
      return state
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase())
      return state
    },
    setCookie(name, value, options) {
      return state.appendHeader(
        'set-cookie',
        serializeCookie(name, value, options)
      )
    },
    clearCookie(name, options) {
      return state.appendHeader(
        'set-cookie',
        serializeCookie(name, '', {
          ...options,
          maxAge: 0,
          expires: new Date(0),
        })
      )
    },
    toHeaders() {
      return mergeHeaders(Object.fromEntries(headers))
    },
  }

  return state
}

/**
 * Merges header maps. Later maps override earlier ones, except `set-cookie`
 * whose values are accumulated.
 */
export const mergeHeaders = (
  ...sources: (ResponseHeaders | undefined)[]
): ResponseHeaders => {
  const result: ResponseHeaders = {}

  for (const source of sources) {
    if (!source) continue

    for (const [name, value] of Object.entries(source)) {
      const key = name.toLowerCase()
      const values = toArray(value)

      if (key === 'set-cookie') {
        const existing = result[key]
        result[key] = [...(existing ? toArray(existing) : []), ...values]
      } else {
        result[key] = values.length === 1 ? values[0] : [...values]
      }
    }
  }

  return result
}
