import type { DotpressRequest } from '@dotpress/core'

/** Methods that must not change state: never cross-site request forgeries. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const hostOf = (url: string | undefined) => {
  if (url === undefined) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * Whether a request may be authenticated by cookies, which the browser
 * attaches to every request, including the ones forged by another site
 * (CSRF). Relies on the headers set by the browser (Fetch Metadata, then
 * `Origin` for older browsers), like the OWASP recommendations and Go's
 * `http.CrossOriginProtection`:
 *
 * - safe methods (`GET`, `HEAD`, `OPTIONS`) are allowed;
 * - a trusted `Origin` is allowed;
 * - with `Sec-Fetch-Site`, only `same-origin` and `none` (typed URL,
 *   bookmark) are allowed: `same-site` covers the other subdomains;
 * - otherwise, an `Origin` is allowed when its host is the API host;
 * - a request with neither header does not come from a browser: allowed.
 */
export const isCookieAuthenticationAllowed = async (
  req: DotpressRequest,
  isTrustedOrigin: (origin: string) => boolean | Promise<boolean>
): Promise<boolean> => {
  if (SAFE_METHODS.has(req.method)) return true

  const origin = req.header('origin')
  if (origin !== undefined && (await isTrustedOrigin(origin))) return true

  const site = req.header('sec-fetch-site')
  if (site !== undefined) return site === 'same-origin' || site === 'none'

  if (origin === undefined) return true
  const originHost = hostOf(origin)
  return (
    originHost !== undefined &&
    originHost === (req.header('host') ?? hostOf(req.url))
  )
}
