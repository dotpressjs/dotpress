import { HttpError } from '@dotpress/core'

/**
 * Code of an error of the authentication routes, in the `error` field of
 * the response: test it, or the status, never the message. New codes may
 * be added in minor versions.
 */
export type AuthRouteErrorCode =
  /** Unknown username, wrong password, or account without password. */
  | 'INVALID_LOGIN'
  /** Over a limit of the login throttle, with `Retry-After`. */
  | 'TOO_MANY_LOGIN_ATTEMPTS'
  /** `/auth/refresh` without tokens, in the body or as cookies. */
  | 'NO_TOKENS_PROVIDED'
  /** Unknown, revoked or reused refresh token. */
  | 'INVALID_REFRESH_TOKEN'
  /** The session reached its inactivity or absolute timeout. */
  | 'EXPIRED_REFRESH_TOKEN'
  /** `/auth/restore` without the cookie mode. */
  | 'COOKIES_NOT_ENABLED'
  /** `/auth/restore` without `cookies.accessTokenInCookie`. */
  | 'ACCESS_TOKEN_NOT_IN_COOKIE'
  /** `/auth/restore` without the refresh token cookie. */
  | 'NO_REFRESH_TOKEN'
  /** `/auth/restore` without the access token cookie. */
  | 'NO_ACCESS_TOKEN'
  /** A cookie request from an untrusted origin. */
  | 'CROSS_ORIGIN_REQUEST'

const ERRORS: Readonly<Record<AuthRouteErrorCode, [number, string]>> = {
  INVALID_LOGIN: [401, 'Invalid username or password.'],
  TOO_MANY_LOGIN_ATTEMPTS: [
    429,
    'Too many failed login attempts. Try again later.',
  ],
  NO_TOKENS_PROVIDED: [
    401,
    'No tokens provided: send the refresh token and the access token.',
  ],
  INVALID_REFRESH_TOKEN: [401, 'Invalid refresh token. Log in again.'],
  EXPIRED_REFRESH_TOKEN: [401, 'The session has expired. Log in again.'],
  COOKIES_NOT_ENABLED: [401, 'The cookie mode is not enabled.'],
  ACCESS_TOKEN_NOT_IN_COOKIE: [
    401,
    'The access token is not stored in a cookie.',
  ],
  NO_REFRESH_TOKEN: [401, 'No refresh token cookie.'],
  NO_ACCESS_TOKEN: [401, 'No access token cookie.'],
  CROSS_ORIGIN_REQUEST: [403, 'Cross-origin request from an untrusted origin.'],
}

/** The error of an authentication route, with its status and message. */
export const authRouteError = (code: AuthRouteErrorCode): HttpError => {
  const [status, message] = ERRORS[code]
  return new HttpError(status, code, message)
}
