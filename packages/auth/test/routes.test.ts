import { decodeJwt } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import {
  cookieHeader,
  cookiesOf,
  createAuthApp,
  login,
  postJson,
} from './support.js'

const COOKIES = { enabled: true, accessTokenInCookie: true }

describe('auth routes', () => {
  describe('POST /auth/login', () => {
    it('returns a token pair and reports the login', async () => {
      const onLoginSuccess = vi.fn(async () => {})
      const { fetch } = await createAuthApp({ settings: { onLoginSuccess } })

      const { res, body } = await login(fetch, {
        username: 'ada',
        password: 'secret',
        client: 'web',
      })

      expect(res.status).toBe(200)
      expect(body).toEqual({
        userId: 'u1',
        accessToken: expect.any(String),
        refreshToken: expect.stringMatching(/^[0-9a-f]{256}$/),
        expiresIn: 3600,
        expiresAt: expect.any(String),
      })
      expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(
        3590 * 1000
      )
      expect(decodeJwt(body.accessToken)).toMatchObject({
        sub: 'u1',
        username: 'ada',
      })
      expect(res.headers.getSetCookie()).toEqual([])
      // Local requests are reported without IP address, like V1.
      expect(onLoginSuccess).toHaveBeenCalledWith({
        userId: 'u1',
        username: 'ada',
        client: 'web',
        ipAddress: '',
      })
    })

    it.each([
      [{ username: 'grace', password: 'secret' }, 'invalid_username'],
      [{ username: 'ada', password: 'wrong' }, 'invalid_password'],
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
        client: '',
        ipAddress: '',
      })
    })

    it('validates the request body', async () => {
      const { fetch } = await createAuthApp()

      const res = await fetch('/auth/login', postJson({ username: 'ada' }))

      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'VALIDATION_FAILED' })
    })

    it('checks the audience against the user role', async () => {
      const onLoginFailed = vi.fn(async () => {})
      const { fetch } = await createAuthApp({
        settings: {
          onLoginFailed,
          aud: {
            required: true,
            isUserRoleAllowed: (role, aud) =>
              aud !== 'backoffice' || role === 'admin',
          },
        },
      })

      expect(
        (await login(fetch, { username: 'ada', password: 'secret' })).res.status
      ).toBe(400)

      const denied = await login(fetch, {
        username: 'linus',
        password: 'secret',
        aud: 'backoffice',
      })
      expect(denied.res.status).toBe(401)
      expect(onLoginFailed).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'invalid_role' })
      )

      const allowed = await login(fetch, {
        username: 'ada',
        password: 'secret',
        aud: 'backoffice',
      })
      expect(decodeJwt(allowed.body.accessToken).aud).toBe('backoffice')
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
        expiresIn: 3600,
        expiresAt: expect.any(String),
      })
      const refreshToken = cookies.dotpress_refresh_token?.value
      expect(refreshToken).toMatch(/^[0-9a-f]{256}$/)
      expect(cookies.dotpress_refresh_token?.raw).toBe(
        `dotpress_refresh_token=${refreshToken}; Max-Age=1209600; Path=/; HttpOnly; Secure; SameSite=Lax`
      )
      expect(decodeJwt(cookies.dotpress_access_token!.value).sub).toBe('u1')
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
      expect(Object.keys(cookiesOf(res))).toEqual(['dotpress_refresh_token'])
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
      expect(refreshed).toMatchObject({ userId: 'u1', expiresIn: 3600 })
      expect(refreshed.refreshToken).not.toBe(tokens.refreshToken)

      const reused = await fetch('/auth/refresh', postJson(tokens))
      expect(reused.status).toBe(401)
      expect(await reused.json()).toMatchObject({
        message: 'INVALID_REFRESH_TOKEN',
      })
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
            dotpress_refresh_token: sent.dotpress_refresh_token!.value,
            dotpress_access_token: sent.dotpress_access_token!.value,
          }),
        },
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        userId: 'u1',
        expiresIn: 3600,
        expiresAt: expect.any(String),
      })
      const cookies = cookiesOf(res)
      expect(cookies.dotpress_refresh_token?.value).toMatch(/^[0-9a-f]{256}$/)
      expect(cookies.dotpress_refresh_token?.value).not.toBe(
        sent.dotpress_refresh_token!.value
      )
      expect(cookies.dotpress_access_token?.value).toBeDefined()
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
            dotpress_refresh_token:
              cookiesOf(loginRes).dotpress_refresh_token!.value,
          }),
        },
      })
      const refreshed = (await res.json()) as Record<string, unknown>

      expect(res.status).toBe(200)
      expect(refreshed.refreshToken).toBeUndefined()
      expect(refreshed.accessToken).toEqual(expect.any(String))
      expect(Object.keys(cookiesOf(res))).toEqual(['dotpress_refresh_token'])
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
        await (await restore(fetch, { dotpress_refresh_token: 'r' })).json()
      ).toMatchObject({ message: 'NO_ACCESS_TOKEN' })
    })

    it('restores a session with a valid access token', async () => {
      const { fetch } = await createAuthApp({ settings: { cookies: COOKIES } })
      const { body: tokens } = await login(fetch)

      const res = await restore(fetch, {
        dotpress_refresh_token: tokens.refreshToken,
        dotpress_access_token: tokens.accessToken,
      })

      expect(await res.json()).toEqual({
        userId: 'u1',
        expiresIn: 3600,
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
        dotpress_refresh_token: tokens.refreshToken,
        dotpress_access_token: tokens.accessToken,
      })
      const restored = (await res.json()) as Record<string, unknown>
      const cookies = cookiesOf(res)

      expect(res.status).toBe(200)
      expect(restored).toEqual({
        userId: 'u1',
        expiresIn: -10,
        expiresAt: expect.any(String),
        user: { id: 'u1', username: 'ada', roles: ['admin'] },
      })
      expect(cookies.dotpress_refresh_token?.value).toMatch(/^[0-9a-f]{256}$/)
      expect(cookies.dotpress_refresh_token?.value).not.toBe(
        tokens.refreshToken
      )
      expect(cookies.dotpress_access_token?.value).toBeDefined()
    })
  })

  describe('POST /auth/logout', () => {
    it('revokes the tokens and clears the cookies', async () => {
      const { fetch, store } = await createAuthApp({
        settings: { cookies: COOKIES },
      })
      const { body: tokens } = await login(fetch)

      expect((await fetch('/auth/logout', { method: 'POST' })).status).toBe(401)

      const res = await fetch('/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })

      expect(await res.json()).toEqual({ success: true })
      expect(
        [...store.refreshTokens.values()].every((token) => token.revokedAt)
      ).toBe(true)
      expect(cookiesOf(res).dotpress_refresh_token?.raw).toContain('Max-Age=0')

      const refresh = await fetch('/auth/refresh', postJson(tokens))
      expect(refresh.status).toBe(401)
    })
  })

  describe('options', () => {
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
        app.routes.map((route) => [
          route.method,
          route.path,
          route.meta.security ?? [],
        ])
      ).toEqual([
        ['post', '/auth/login', []],
        ['post', '/auth/refresh', []],
        ['get', '/auth/me', ['bearerAuth']],
        ['post', '/auth/restore', []],
        ['post', '/auth/logout', ['bearerAuth']],
      ])
    })
  })
})
