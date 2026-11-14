import bcrypt from 'bcryptjs'
import { decodeJwt } from 'jose'
import { createTestApp } from '@dotpress/testing'
import { describe, expect, it, vi } from 'vitest'
import { authPlugin, createAuth } from '../src/index.js'
import {
  ACCESS_COOKIE,
  cookieHeader,
  cookiesOf,
  createAuthApp,
  createStore,
  keys,
  login,
  postJson,
  REFRESH_COOKIE,
  type AuthAppOptions,
} from './support.js'

const COOKIES = { enabled: true, accessTokenInCookie: true }
const DAY = 24 * 60 * 60
// The seconds left until the `exp` claim of a new access token, a whole
// second: 899 when a second starts between the signature and the response.
const EXPIRES_IN = expect.toBeOneOf([899, 900])

describe('auth routes', () => {
  describe('POST /auth/login', () => {
    it('returns a token pair and reports the login', async () => {
      const onLoginSuccess = vi.fn(async () => {})
      const { fetch } = await createAuthApp({ settings: { onLoginSuccess } })

      const { res, body } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        clientId: 'web',
      })

      expect(res.status).toBe(200)
      expect(body).toEqual({
        userId: 'u1',
        accessToken: expect.any(String),
        refreshToken: expect.stringMatching(/^[0-9a-f]{256}$/),
        expiresIn: EXPIRES_IN,
        expiresAt: expect.any(String),
      })
      expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(
        890 * 1000
      )
      const claims = decodeJwt(body.accessToken)
      expect(claims).toMatchObject({ sub: 'u1' })
      expect(claims).not.toHaveProperty('username')
      // Without clients setting, the clientId is not written in the token.
      expect(claims).not.toHaveProperty('client_id')
      expect(res.headers.getSetCookie()).toEqual([])
      // Local requests are reported without IP address, like V1.
      expect(onLoginSuccess).toHaveBeenCalledWith({
        userId: 'u1',
        username: 'ada',
        clientId: 'web',
        ipAddress: '',
      })
    })

    it.each([
      [{ username: 'grace', password: 'secret' }, 'invalid_username'],
      [{ username: 'ada', password: 'wrong' }, 'invalid_password'],
      // Account without password (SSO): it exists, the password is wrong.
      [{ username: 'margaret', password: '' }, 'invalid_password'],
    ])('rejects invalid credentials (%o)', async (credentials, errorType) => {
      const onLoginFailed = vi.fn(async () => {})
      const { fetch } = await createAuthApp({ settings: { onLoginFailed } })

      const { res, body } = await login(fetch, credentials)

      expect(res.status).toBe(401)
      expect(body).toEqual({
        status: 401,
        error: 'UNAUTHORIZED',
        message: 'INVALID_LOGIN',
      })
      expect(onLoginFailed).toHaveBeenCalledWith({
        username: credentials.username,
        errorType,
        clientId: '',
        ipAddress: '',
      })
    })

    it('answers unknown users in the time of a wrong password', async () => {
      // Higher cost than the other tests, so that the bcrypt time dominates
      // the measure (around 15 ms per login).
      const rounds = 8
      const { fetch, store } = await createAuthApp({
        settings: { passwordHashRounds: rounds },
      })
      store.users.get('u1')!.passwordHash = bcrypt.hashSync('secret', rounds)

      const usernames = ['ada', 'grace', 'margaret'] as const
      const durations = new Map(usernames.map((name) => [name, [] as number[]]))
      // Warm-up, then the three logins in turn: a slower moment of the
      // machine (CI runners, tests running in parallel) slows all of them.
      for (const username of usernames) {
        await login(fetch, { username, password: 'wrong' })
      }
      for (let index = 0; index < 7; index++) {
        for (const username of usernames) {
          const start = performance.now()
          await login(fetch, { username, password: 'wrong' })
          durations.get(username)!.push(performance.now() - start)
        }
      }
      const median = (username: (typeof usernames)[number]) =>
        durations.get(username)!.sort((a, b) => a - b)[3]!

      const wrongPassword = median('ada')
      // Without dummy hash: about 0.3 ms against 15 ms, 50 times less. A
      // third leaves room for the noise of the measure.
      expect(median('grace')).toBeGreaterThan(wrongPassword / 3)
      expect(median('margaret')).toBeGreaterThan(wrongPassword / 3)
    })

    it('validates the request body', async () => {
      const { fetch } = await createAuthApp()

      const res = await fetch('/auth/login', postJson({ username: 'ada' }))

      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'VALIDATION_FAILED' })
    })

    it('checks the client against the allowed clients and the user role', async () => {
      const onLoginFailed = vi.fn(async () => {})
      const { fetch } = await createAuthApp({
        settings: {
          onLoginFailed,
          clients: {
            allowed: ['app', 'backoffice'],
            required: true,
            isUserRoleAllowed: (role, clientId) =>
              clientId !== 'backoffice' || role === 'admin',
          },
        },
      })

      // Missing or unknown client.
      expect(
        (await login(fetch, { username: 'ada', password: 'secret' })).res.status
      ).toBe(400)
      const unknown = await login(fetch, {
        username: 'ada',
        password: 'secret',
        clientId: 'billing-admin',
      })
      expect(unknown.res.status).toBe(400)
      expect(unknown.body).toMatchObject({ error: 'VALIDATION_FAILED' })

      const denied = await login(fetch, {
        username: 'linus',
        password: 'secret',
        clientId: 'backoffice',
      })
      expect(denied.res.status).toBe(401)
      expect(onLoginFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: 'invalid_role',
          clientId: 'backoffice',
        })
      )

      const allowed = await login(fetch, {
        username: 'ada',
        password: 'secret',
        clientId: 'backoffice',
      })
      expect(decodeJwt(allowed.body.accessToken)).toMatchObject({
        client_id: 'backoffice',
        aud: 'https://api.example.com',
      })
    })

    it('sets the token cookies in cookie mode, without returning them', async () => {
      const { fetch } = await createAuthApp({ settings: { cookies: COOKIES } })

      const { res, body } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        mode: 'cookie',
      })
      const cookies = cookiesOf(res)

      // Tokens set as HttpOnly cookies must not be readable by JavaScript.
      expect(body).toEqual({
        userId: 'u1',
        expiresIn: EXPIRES_IN,
        expiresAt: expect.any(String),
      })
      const refreshToken = cookies[REFRESH_COOKIE]?.value
      expect(refreshToken).toMatch(/^[0-9a-f]{256}$/)
      expect(cookies[REFRESH_COOKIE]?.raw).toBe(
        `${REFRESH_COOKIE}=${refreshToken}; Max-Age=1209600; Path=/auth; HttpOnly; Secure; SameSite=Strict`
      )
      const accessToken = cookies[ACCESS_COOKIE]!.value
      expect(decodeJwt(accessToken).sub).toBe('u1')
      // It accompanies navigations from other sites, and lives as long as
      // the refresh token: refreshing requires it, even expired.
      expect(cookies[ACCESS_COOKIE]?.raw).toBe(
        `${ACCESS_COOKIE}=${accessToken}; Max-Age=1209600; Path=/; HttpOnly; Secure; SameSite=Lax`
      )
    })

    it('returns the access token only, when it is not a cookie', async () => {
      const { fetch } = await createAuthApp({
        settings: { cookies: { enabled: true } },
      })

      const { res, body } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        mode: 'cookie',
      })

      expect(body.refreshToken).toBeUndefined()
      expect(decodeJwt(body.accessToken).sub).toBe('u1')
      expect(Object.keys(cookiesOf(res))).toEqual([REFRESH_COOKIE])
    })

    it('returns the tokens when cookie mode is requested but disabled', async () => {
      const { fetch } = await createAuthApp()

      const { res, body } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        mode: 'cookie',
      })

      expect(body).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      })
      expect(res.headers.getSetCookie()).toEqual([])
    })
  })

  describe('POST /auth/refresh', () => {
    it('rotates tokens sent in the body', async () => {
      const { fetch } = await createAuthApp()
      const { body: tokens } = await login(fetch)

      const res = await fetch('/auth/refresh', postJson(tokens))
      const refreshed = (await res.json()) as typeof tokens

      expect(res.status).toBe(200)
      expect(refreshed).toMatchObject({ userId: 'u1', expiresIn: EXPIRES_IN })
      expect(refreshed.refreshToken).not.toBe(tokens.refreshToken)

      // Retry within the reuse interval (lost response): a new pair.
      const retried = await fetch('/auth/refresh', postJson(tokens))
      expect(retried.status).toBe(200)
      expect(((await retried.json()) as typeof tokens).refreshToken).not.toBe(
        refreshed.refreshToken
      )
    })

    it('rotates tokens sent as cookies, and only sets the new cookies', async () => {
      const { fetch } = await createAuthApp({ settings: { cookies: COOKIES } })
      const { res: loginRes } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        mode: 'cookie',
      })
      const sent = cookiesOf(loginRes)

      const res = await fetch('/auth/refresh', {
        method: 'POST',
        headers: {
          cookie: cookieHeader({
            [REFRESH_COOKIE]: sent[REFRESH_COOKIE]!.value,
            [ACCESS_COOKIE]: sent[ACCESS_COOKIE]!.value,
          }),
        },
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        userId: 'u1',
        expiresIn: EXPIRES_IN,
        expiresAt: expect.any(String),
      })
      const cookies = cookiesOf(res)
      expect(cookies[REFRESH_COOKIE]?.value).toMatch(/^[0-9a-f]{256}$/)
      expect(cookies[REFRESH_COOKIE]?.value).not.toBe(
        sent[REFRESH_COOKIE]!.value
      )
      expect(cookies[ACCESS_COOKIE]?.value).toBeDefined()
    })

    it('returns the access token only in hybrid mode', async () => {
      const { fetch } = await createAuthApp({
        settings: { cookies: { enabled: true } },
      })
      const { res: loginRes, body } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        mode: 'cookie',
      })

      const res = await fetch('/auth/refresh', {
        ...postJson({ accessToken: body.accessToken }),
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader({
            [REFRESH_COOKIE]: cookiesOf(loginRes)[REFRESH_COOKIE]!.value,
          }),
        },
      })
      const refreshed = (await res.json()) as Record<string, unknown>

      expect(res.status).toBe(200)
      expect(refreshed.refreshToken).toBeUndefined()
      expect(refreshed.accessToken).toEqual(expect.any(String))
      expect(Object.keys(cookiesOf(res))).toEqual([REFRESH_COOKIE])
    })

    it('revokes the session when a used refresh token is reused', async () => {
      const { fetch } = await createAuthApp({
        settings: { refreshTokenReuseInterval: 0 },
      })
      const { body: stolen } = await login(fetch)
      const attacker = (await (
        await fetch('/auth/refresh', postJson(stolen))
      ).json()) as typeof stolen

      const reused = await fetch('/auth/refresh', postJson(stolen))
      expect(reused.status).toBe(401)
      expect(await reused.json()).toMatchObject({
        message: 'INVALID_REFRESH_TOKEN',
      })

      // The attacker's rotated tokens are revoked with the session.
      const next = await fetch('/auth/refresh', postJson(attacker))
      expect(next.status).toBe(401)
    })

    it('reports missing and expired tokens', async () => {
      const { fetch, store } = await createAuthApp()

      const missing = await fetch('/auth/refresh', { method: 'POST' })
      expect(missing.status).toBe(401)
      expect(await missing.json()).toMatchObject({
        message: 'NO_TOKENS_PROVIDED',
      })

      const { body: tokens } = await login(fetch)
      ;[...store.refreshTokens.values()][0]!.expiresAt = new Date(0)

      const expired = await fetch('/auth/refresh', postJson(tokens))
      expect(await expired.json()).toMatchObject({
        message: 'EXPIRED_REFRESH_TOKEN',
      })
    })

    it('answers 401 instead of 500 for an invalid access token', async () => {
      const { fetch } = await createAuthApp()
      const { body: tokens } = await login(fetch)

      const res = await fetch(
        '/auth/refresh',
        postJson({ ...tokens, accessToken: 'not.a.token' })
      )

      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({
        message: 'INVALID_REFRESH_TOKEN',
      })
    })
  })

  describe('GET /auth/me', () => {
    it('returns the authenticated user', async () => {
      const { fetch } = await createAuthApp()
      const { body: tokens } = await login(fetch)

      expect((await fetch('/auth/me')).status).toBe(401)

      const res = await fetch('/auth/me', {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      expect(await res.json()).toEqual({
        id: 'u1',
        username: 'ada',
        roles: ['admin'],
      })
    })
  })

  describe('POST /auth/restore', () => {
    const restore = (
      fetch: (path: string, init?: RequestInit) => Promise<Response>,
      cookies: Record<string, string>
    ) =>
      fetch('/auth/restore', {
        method: 'POST',
        headers: { cookie: cookieHeader(cookies) },
      })

    it('requires cookies with the access token', async () => {
      const disabled = await createAuthApp()
      expect(await (await restore(disabled.fetch, {})).json()).toMatchObject({
        message: 'COOKIES_NOT_ENABLED',
      })

      const refreshOnly = await createAuthApp({
        settings: { cookies: { enabled: true } },
      })
      expect(await (await restore(refreshOnly.fetch, {})).json()).toMatchObject(
        { message: 'ACCESS_TOKEN_NOT_IN_COOKIE' }
      )

      const { fetch } = await createAuthApp({ settings: { cookies: COOKIES } })
      expect(await (await restore(fetch, {})).json()).toMatchObject({
        message: 'NO_REFRESH_TOKEN',
      })
      expect(
        await (await restore(fetch, { [REFRESH_COOKIE]: 'r' })).json()
      ).toMatchObject({ message: 'NO_ACCESS_TOKEN' })
    })

    it('restores a session with a valid access token', async () => {
      const { fetch } = await createAuthApp({ settings: { cookies: COOKIES } })
      const { body: tokens } = await login(fetch)

      const res = await restore(fetch, {
        [REFRESH_COOKIE]: tokens.refreshToken,
        [ACCESS_COOKIE]: tokens.accessToken,
      })

      expect(await res.json()).toEqual({
        userId: 'u1',
        expiresIn: EXPIRES_IN,
        expiresAt: expect.any(String),
        user: { id: 'u1', username: 'ada', roles: ['admin'] },
      })
      expect(res.headers.getSetCookie()).toEqual([])
    })

    it('refreshes the session when the access token expired', async () => {
      const { fetch } = await createAuthApp({
        settings: { cookies: COOKIES, accessTokenTTL: -10 },
      })
      const { body: tokens } = await login(fetch)

      const res = await restore(fetch, {
        [REFRESH_COOKIE]: tokens.refreshToken,
        [ACCESS_COOKIE]: tokens.accessToken,
      })
      const restored = (await res.json()) as Record<string, unknown>
      const cookies = cookiesOf(res)

      expect(res.status).toBe(200)
      expect(restored).toEqual({
        userId: 'u1',
        // The access token issued with a negative lifetime is expired.
        expiresIn: 0,
        expiresAt: expect.any(String),
        user: { id: 'u1', username: 'ada', roles: ['admin'] },
      })
      expect(cookies[REFRESH_COOKIE]?.value).toMatch(/^[0-9a-f]{256}$/)
      expect(cookies[REFRESH_COOKIE]?.value).not.toBe(tokens.refreshToken)
      expect(cookies[ACCESS_COOKIE]?.value).toBeDefined()
    })
  })

  describe('cookie SameSite attributes', () => {
    it.each([
      [{}, 'Strict', 'Lax'],
      [{ sameSite: 'none' as const }, 'None', 'None'],
      [{ refreshTokenSameSite: 'lax' as const }, 'Lax', 'Lax'],
    ])(
      'sets them from the settings (%o)',
      async (settings, refreshSameSite, accessSameSite) => {
        const { fetch } = await createAuthApp({
          settings: { cookies: { ...COOKIES, ...settings } },
        })

        const { res } = await login(fetch, {
          username: 'ada',
          password: 'secret',
          mode: 'cookie',
        })
        const cookies = cookiesOf(res)

        expect(cookies[REFRESH_COOKIE]?.raw).toContain(
          `SameSite=${refreshSameSite}`
        )
        expect(cookies[ACCESS_COOKIE]?.raw).toContain(
          `SameSite=${accessSameSite}`
        )
      }
    )
  })

  describe('sessions', () => {
    it('returns sessionExpiresAt and bounds the cookies with an absolute timeout', async () => {
      const { fetch } = await createAuthApp({
        settings: {
          cookies: { enabled: true },
          session: { idleTimeout: 7 * DAY, absoluteTimeout: DAY },
        },
      })

      const { res, body } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        mode: 'cookie',
      })
      const sessionExpiresAt = (body as { sessionExpiresAt?: string })
        .sessionExpiresAt

      expect(
        new Date(sessionExpiresAt!).getTime() - Date.now()
      ).toBeGreaterThan((DAY - 10) * 1000)
      // The refresh token cookie expires with the session, not after the
      // inactivity timeout.
      const maxAge = Number(
        /Max-Age=(\d+)/.exec(cookiesOf(res)[REFRESH_COOKIE]!.raw)![1]
      )
      expect(maxAge).toBeGreaterThan(DAY - 10)
      expect(maxAge).toBeLessThanOrEqual(DAY)
    })

    it('does not return sessionExpiresAt without absolute timeout', async () => {
      const { fetch } = await createAuthApp()
      const { body } = await login(fetch)

      expect(body).not.toHaveProperty('sessionExpiresAt')
    })
  })

  describe('password hash upgrade', () => {
    it('rehashes the password at login when the cost changed', async () => {
      const { fetch, store, auth } = await createAuthApp({
        settings: { passwordHashRounds: 5 },
      })
      const updatePasswordHash = vi.spyOn(store.provider, 'updatePasswordHash')

      expect((await login(fetch)).res.status).toBe(200)
      const upgraded = store.users.get('u1')!.passwordHash!
      expect(updatePasswordHash).toHaveBeenCalledWith('u1', upgraded)
      expect(upgraded).toMatch(/^\$2[aby]\$05\$/)
      await expect(auth.verifyPassword('secret', upgraded)).resolves.toBe(true)

      updatePasswordHash.mockClear()
      expect((await login(fetch)).res.status).toBe(200)
      expect(updatePasswordHash).not.toHaveBeenCalled()
    })

    it('does not rehash with the same cost, or after a failed login', async () => {
      const { fetch, store } = await createAuthApp()
      const updatePasswordHash = vi.spyOn(store.provider, 'updatePasswordHash')

      await login(fetch)
      await login(fetch, { username: 'linus', password: 'wrong' })

      expect(updatePasswordHash).not.toHaveBeenCalled()
    })

    it('logs in when the hash update fails, or is not supported', async () => {
      const { fetch, store, logger } = await createAuthApp({
        settings: { passwordHashRounds: 5 },
      })
      vi.spyOn(store.provider, 'updatePasswordHash').mockRejectedValue(
        new Error('Read-only database')
      )

      expect((await login(fetch)).res.status).toBe(200)
      expect(
        logger.entries.some(
          (entry) => entry.args[1] === 'Cannot update the password hash'
        )
      ).toBe(true)

      delete store.provider.updatePasswordHash
      expect((await login(fetch)).res.status).toBe(200)
    })
  })

  describe('POST /auth/logout', () => {
    const twoSessions = async (settings = {}) => {
      const app = await createAuthApp({ settings })
      const first = (await login(app.fetch)).body
      const second = (await login(app.fetch)).body
      const refreshStatus = async (tokens: typeof first) =>
        (
          await app.fetch(
            '/auth/refresh',
            postJson({
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
            })
          )
        ).status
      return {
        ...app,
        first,
        second,
        refreshStatus,
        logout: (body?: Record<string, unknown>, headers = {}) =>
          logout(app.fetch, body, headers),
      }
    }
    // Hoisted: used by twoSessions().
    function logout(
      fetch: (path: string, init?: RequestInit) => Promise<Response>,
      body?: Record<string, unknown>,
      headers: Record<string, string> = {}
    ) {
      return fetch('/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        ...(body && { body: JSON.stringify(body) }),
      })
    }

    it('revokes the current session with the refresh token', async () => {
      const { fetch, first, second, refreshStatus } = await twoSessions()

      const res = await logout(fetch, { refreshToken: first.refreshToken })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true })
      expect(await refreshStatus(first)).toBe(401)
      expect(await refreshStatus(second)).toBe(200)
    })

    it('revokes the current session with the access token only', async () => {
      const { fetch, first, second, refreshStatus } = await twoSessions()

      const res = await logout(fetch, undefined, {
        authorization: `Bearer ${first.accessToken}`,
      })

      expect(res.status).toBe(200)
      expect(await refreshStatus(first)).toBe(401)
      expect(await refreshStatus(second)).toBe(200)
    })

    it('revokes every session with scope all', async () => {
      for (const proof of ['refresh token', 'access token']) {
        const { fetch, first, second, refreshStatus } = await twoSessions()

        const res =
          proof === 'refresh token'
            ? await logout(fetch, {
                refreshToken: first.refreshToken,
                scope: 'all',
              })
            : await logout(
                fetch,
                { scope: 'all' },
                { authorization: `Bearer ${first.accessToken}` }
              )

        expect(res.status).toBe(200)
        expect(await refreshStatus(first)).toBe(401)
        expect(await refreshStatus(second)).toBe(401)
      }
    })

    it('falls back to the access token for unknown or used refresh tokens', async () => {
      const current = await twoSessions()
      await current.logout(
        { refreshToken: 'unknown' },
        { authorization: `Bearer ${current.first.accessToken}` }
      )
      expect(await current.refreshStatus(current.first)).toBe(401)
      expect(await current.refreshStatus(current.second)).toBe(200)

      const all = await twoSessions()
      const rotated = (await all.fetch('/auth/refresh', postJson(all.first))).ok
      expect(rotated).toBe(true)
      const res = await all.logout(
        { refreshToken: all.first.refreshToken, scope: 'all' },
        { authorization: `Bearer ${all.first.accessToken}` }
      )
      expect(res.status).toBe(200)
      expect(await all.refreshStatus(all.second)).toBe(401)
    })

    it('reads the refresh token cookie before the body', async () => {
      const { fetch, store } = await createAuthApp({
        settings: { cookies: COOKIES },
      })
      const { res: loginRes } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        mode: 'cookie',
      })
      const other = (await login(fetch)).body

      await logout(
        fetch,
        { refreshToken: other.refreshToken },
        {
          cookie: cookieHeader({
            [REFRESH_COOKIE]: cookiesOf(loginRes)[REFRESH_COOKIE]!.value,
          }),
        }
      )

      const revoked = [...store.refreshTokens.values()].filter(
        (token) => token.revokedAt
      )
      expect(revoked).toHaveLength(1)
      expect(revoked[0]!.familyId).not.toBe(decodeJwt(other.accessToken).sid)
    })

    it('does not require a valid access token in cookie mode', async () => {
      const { fetch, store } = await createAuthApp({
        settings: { cookies: COOKIES, accessTokenTTL: -10 },
      })
      const { res: loginRes } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        mode: 'cookie',
      })
      const other = (await login(fetch)).body
      const refreshToken = cookiesOf(loginRes)[REFRESH_COOKIE]!.value

      const res = await logout(fetch, undefined, {
        cookie: cookieHeader({ [REFRESH_COOKIE]: refreshToken }),
      })

      expect(res.status).toBe(200)
      // A cookie is only cleared with its path.
      expect(cookiesOf(res)[REFRESH_COOKIE]?.raw).toMatch(
        /Max-Age=0;.* Path=\/auth;/
      )
      expect(cookiesOf(res)[ACCESS_COOKIE]?.raw).toMatch(
        /Max-Age=0;.* Path=\/;/
      )
      const revoked = [...store.refreshTokens.values()].filter(
        (token) => token.revokedAt
      )
      expect(revoked).toHaveLength(1)
      expect(revoked[0]!.familyId).not.toBe(decodeJwt(other.accessToken).sid)
    })

    it('rejects the refresh token cookie of cross-origin requests', async () => {
      const { fetch, store } = await createAuthApp({
        settings: { cookies: COOKIES },
      })
      const { res: loginRes } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        mode: 'cookie',
      })

      const res = await logout(fetch, undefined, {
        origin: 'https://evil.com',
        'sec-fetch-site': 'cross-site',
        cookie: cookieHeader({
          [REFRESH_COOKIE]: cookiesOf(loginRes)[REFRESH_COOKIE]!.value,
        }),
      })

      expect(res.status).toBe(403)
      expect(
        [...store.refreshTokens.values()].some((token) => token.revokedAt)
      ).toBe(false)
    })

    it('logs out without a valid token, and clears the cookies', async () => {
      const { fetch, store } = await createAuthApp({
        settings: { cookies: COOKIES },
      })
      await login(fetch)

      for (const body of [undefined, { refreshToken: 'unknown' }]) {
        const res = await logout(fetch, body, {
          authorization: 'Bearer not.a.token',
        })
        expect(res.status).toBe(200)
        expect(cookiesOf(res)[REFRESH_COOKIE]?.raw).toContain('Max-Age=0')
      }
      expect(
        [...store.refreshTokens.values()].some((token) => token.revokedAt)
      ).toBe(false)
    })

    it('requires a proof to revoke every session', async () => {
      const { fetch, first, second, refreshStatus } = await twoSessions()
      const rotated = (await fetch('/auth/refresh', postJson(first))).ok
      expect(rotated).toBe(true)

      for (const body of [
        { scope: 'all' },
        { scope: 'all', refreshToken: 'unknown' },
        // Used by the rotation above.
        { scope: 'all', refreshToken: first.refreshToken },
      ]) {
        expect((await logout(fetch, body)).status).toBe(401)
      }
      expect(await refreshStatus(second)).toBe(200)
    })

    it('rejects an unknown scope', async () => {
      const { fetch, first } = await twoSessions()

      const res = await logout(fetch, {
        refreshToken: first.refreshToken,
        scope: 'others',
      })

      expect(res.status).toBe(400)
    })
  })

  describe('revocation', () => {
    const me = (
      fetch: (path: string, init?: RequestInit) => Promise<Response>,
      accessToken: string
    ) =>
      fetch('/auth/me', { headers: { authorization: `Bearer ${accessToken}` } })

    it('rejects the access tokens of revoked sessions at once', async () => {
      const { fetch } = await createAuthApp({ sessionRevocation: true })
      const first = (await login(fetch)).body
      const second = (await login(fetch)).body

      await fetch(
        '/auth/logout',
        postJson({ refreshToken: first.refreshToken })
      )

      expect((await me(fetch, first.accessToken)).status).toBe(401)
      expect((await me(fetch, second.accessToken)).status).toBe(200)

      await fetch(
        '/auth/logout',
        postJson({ refreshToken: second.refreshToken, scope: 'all' })
      )
      expect((await me(fetch, second.accessToken)).status).toBe(401)
    })

    it('rejects the access tokens of a session revoked by reuse', async () => {
      const { fetch } = await createAuthApp({
        sessionRevocation: true,
        settings: { refreshTokenReuseInterval: 0 },
      })
      const stolen = (await login(fetch)).body
      const rotated = (await (
        await fetch('/auth/refresh', postJson(stolen))
      ).json()) as typeof stolen

      expect((await fetch('/auth/refresh', postJson(stolen))).status).toBe(401)
      expect((await me(fetch, rotated.accessToken)).status).toBe(401)
    })

    it('does not restore a revoked session', async () => {
      const { fetch } = await createAuthApp({
        sessionRevocation: true,
        settings: { cookies: COOKIES },
      })
      const { body: tokens } = await login(fetch)
      await fetch(
        '/auth/logout',
        postJson({ refreshToken: tokens.refreshToken })
      )

      const res = await fetch('/auth/restore', {
        method: 'POST',
        headers: {
          cookie: cookieHeader({
            [REFRESH_COOKIE]: tokens.refreshToken,
            [ACCESS_COOKIE]: tokens.accessToken,
          }),
        },
      })

      expect(res.status).toBe(401)
    })

    it('ends the session of a deleted user at refresh', async () => {
      const { fetch, store } = await createAuthApp()
      const { body: tokens } = await login(fetch)
      store.users.delete('u1')

      const res = await fetch('/auth/refresh', postJson(tokens))

      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({
        message: 'INVALID_REFRESH_TOKEN',
      })
    })
  })

  describe('options', () => {
    describe('refresh token cookie path', () => {
      const cookies = { enabled: true, accessTokenInCookie: true }

      /** Logs in with cookies at `loginPath`, and returns the cookies. */
      const cookieLogin = async (
        fetch: (path: string, init?: RequestInit) => Promise<Response>,
        loginPath: string
      ) => {
        const res = await fetch(
          loginPath,
          postJson({ username: 'ada', password: 'secret', mode: 'cookie' })
        )
        expect(res.status).toBe(200)
        return cookiesOf(res)
      }

      it('is the path of the auth routes', async () => {
        const { fetch, auth } = await createAuthApp({ settings: { cookies } })

        const sent = await cookieLogin(fetch, '/auth/login')

        expect(sent[REFRESH_COOKIE]?.raw).toContain('Path=/auth;')
        expect(auth.settings.cookies.refreshTokenPath).toBe('/auth')
      })

      it('follows a custom prefix', async () => {
        const { fetch } = await createAuthApp({
          settings: { cookies },
          plugin: { prefix: '/api/session/' },
        })
        const sent = await cookieLogin(fetch, '/api/session/login')
        expect(sent[REFRESH_COOKIE]?.raw).toContain('Path=/api/session;')

        const res = await fetch('/api/session/refresh', {
          method: 'POST',
          headers: {
            cookie: cookieHeader({
              [REFRESH_COOKIE]: sent[REFRESH_COOKIE]!.value,
              [ACCESS_COOKIE]: sent[ACCESS_COOKIE]!.value,
            }),
          },
        })

        expect(res.status).toBe(200)
        expect(cookiesOf(res)[REFRESH_COOKIE]?.raw).toContain(
          'Path=/api/session;'
        )
      })

      it('gets the __Host- prefix with routes at the root', async () => {
        const { fetch } = await createAuthApp({
          settings: { cookies },
          plugin: { prefix: '/' },
        })

        const sent = await cookieLogin(fetch, '/login')

        expect(sent['__Host-dotpress_refresh_token']?.raw).toContain('Path=/;')
      })

      it('includes the base path of the app', async () => {
        const { fetch } = await createAuthApp({
          settings: { cookies },
          app: { basePath: '/my-app/api' },
        })

        const sent = await cookieLogin(fetch, '/my-app/api/auth/login')

        expect(sent[REFRESH_COOKIE]?.raw).toContain('Path=/my-app/api/auth;')
      })

      it('includes the public base path of the app', async () => {
        const { fetch } = await createAuthApp({
          settings: { cookies },
          plugin: { prefix: '/session' },
          app: { publicBasePath: '/my-app/api' },
        })

        // The proxy removes the prefix: the routes are not prefixed.
        const sent = await cookieLogin(fetch, '/session/login')

        expect(sent[REFRESH_COOKIE]?.raw).toContain('Path=/my-app/api/session;')
      })

      it('can be forced with cookies.refreshTokenPath', async () => {
        const { fetch } = await createAuthApp({
          settings: { cookies: { ...cookies, refreshTokenPath: '/' } },
          app: { basePath: '/api' },
        })

        const sent = await cookieLogin(fetch, '/api/auth/login')

        expect(sent['__Host-dotpress_refresh_token']?.raw).toContain('Path=/;')
      })

      it('stays /auth without the auth routes', async () => {
        const { auth } = await createAuthApp({
          settings: { cookies },
          plugin: { prefix: '/session', routes: false },
          app: { basePath: '/api' },
        })

        expect(auth.settings.cookies.refreshTokenPath).toBe('/auth')
      })

      it('cannot differ between two apps sharing an auth service', async () => {
        const auth = createAuth({
          keys,
          dataProvider: createStore().provider,
          issuer: 'https://api.example.com',
          cookies,
        })
        const app = (options: AuthAppOptions['app']) =>
          createTestApp({ ...options, plugins: [authPlugin(auth)] })

        await app({ basePath: '/a' })
        await expect(app({ basePath: '/a' })).resolves.toBeDefined()
        await expect(app({ basePath: '/b' })).rejects.toThrow(
          'This auth service already serves routes under "/a/auth": create one auth service per app to serve them under "/b/auth".'
        )
        expect(auth.settings.cookies.refreshTokenPath).toBe('/a/auth')
      })

      it('rejects an invalid routes path', async () => {
        const auth = createAuth({
          keys,
          dataProvider: createStore().provider,
          issuer: 'https://api.example.com',
        })

        await expect(auth.init({ routesPath: 'auth' })).rejects.toThrow(
          'Invalid routesPath: expected a path starting with "/", received "auth".'
        )
      })
    })

    it('mounts the routes under a custom prefix', async () => {
      const { fetch } = await createAuthApp({
        plugin: { prefix: '/api/session' },
      })

      expect(
        (
          await fetch(
            '/api/session/login',
            postJson({ username: 'ada', password: 'secret' })
          )
        ).status
      ).toBe(200)
      expect((await fetch('/auth/login', { method: 'POST' })).status).toBe(404)
    })

    it('can skip the routes', async () => {
      const { fetch, app } = await createAuthApp({ plugin: { routes: false } })

      expect(app.routes).toEqual([])
      expect((await fetch('/auth/login', { method: 'POST' })).status).toBe(404)
    })

    it('documents the routes', async () => {
      const { app } = await createAuthApp()

      expect(
        app.routes.map((route) => [route.method, route.path, route.security])
      ).toEqual([
        ['post', '/auth/login', []],
        ['post', '/auth/refresh', []],
        ['get', '/auth/me', [['bearerAuth']]],
        ['post', '/auth/restore', []],
        ['post', '/auth/logout', []],
      ])
    })
  })
})
