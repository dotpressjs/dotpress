import { HttpError } from '@dotpress/core'
import { describe, expect, it } from 'vitest'
import type { AuthRouteErrorCode } from '../src/index.js'
import { authRouteError } from '../src/route-errors.js'

const STATUSES: Record<AuthRouteErrorCode, number> = {
  INVALID_LOGIN: 401,
  TOO_MANY_LOGIN_ATTEMPTS: 429,
  NO_TOKENS_PROVIDED: 401,
  INVALID_REFRESH_TOKEN: 401,
  EXPIRED_REFRESH_TOKEN: 401,
  COOKIES_NOT_ENABLED: 401,
  ACCESS_TOKEN_NOT_IN_COOKIE: 401,
  NO_REFRESH_TOKEN: 401,
  NO_ACCESS_TOKEN: 401,
  CROSS_ORIGIN_REQUEST: 403,
}

describe('errors of the authentication routes', () => {
  it.each(Object.entries(STATUSES) as [AuthRouteErrorCode, number][])(
    '%s: the code in `error`, a sentence in `message`',
    (code, status) => {
      const error = authRouteError(code)

      expect(error).toBeInstanceOf(HttpError)
      expect(error.toJSON()).toEqual({
        status,
        error: code,
        message: expect.stringMatching(/^[A-Z][^_]+\.$/),
      })
    }
  )
})
