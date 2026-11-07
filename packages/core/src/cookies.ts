export interface CookieOptions {
  /** Lifetime in seconds. */
  maxAge?: number
  expires?: Date
  /** Defaults to `/`. */
  path?: string
  domain?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'strict' | 'lax' | 'none'
  partitioned?: boolean
  priority?: 'low' | 'medium' | 'high'
}

// RFC 6265 cookie-name (token) and attribute value characters.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const ATTRIBUTE_VALUE = /^[!-:<-~]*$/

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1)

const assertAttribute = (name: string, value: string) => {
  if (!ATTRIBUTE_VALUE.test(value)) {
    throw new TypeError(`Invalid cookie ${name}: ${value}`)
  }
}

/**
 * Serializes a `Set-Cookie` header value. The cookie value is URI-encoded.
 */
export const serializeCookie = (
  name: string,
  value: string,
  options: CookieOptions = {}
): string => {
  if (!COOKIE_NAME.test(name)) {
    throw new TypeError(`Invalid cookie name: ${name}`)
  }

  const parts = [`${name}=${encodeURIComponent(value)}`]

  if (options.maxAge !== undefined) {
    if (!Number.isFinite(options.maxAge)) {
      throw new TypeError(`Invalid cookie maxAge: ${options.maxAge}`)
    }
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
  }

  if (options.expires !== undefined) {
    if (Number.isNaN(options.expires.getTime())) {
      throw new TypeError('Invalid cookie expires date')
    }
    parts.push(`Expires=${options.expires.toUTCString()}`)
  }

  if (options.domain !== undefined) {
    assertAttribute('domain', options.domain)
    parts.push(`Domain=${options.domain}`)
  }

  const path = options.path ?? '/'
  assertAttribute('path', path)
  parts.push(`Path=${path}`)

  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.partitioned) parts.push('Partitioned')
  if (options.sameSite) parts.push(`SameSite=${capitalize(options.sameSite)}`)
  if (options.priority) parts.push(`Priority=${capitalize(options.priority)}`)

  return parts.join('; ')
}

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Parses a `Cookie` request header. The first occurrence of a name wins.
 */
export const parseCookieHeader = (
  header: string | undefined
): Record<string, string> => {
  const cookies: Record<string, string> = {}

  if (!header) {
    return cookies
  }

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue

    const name = pair.slice(0, separator).trim()
    if (!name || Object.hasOwn(cookies, name)) continue

    let value = pair.slice(separator + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1)
    }

    cookies[name] = safeDecode(value)
  }

  return cookies
}
