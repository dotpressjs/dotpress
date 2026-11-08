import { createRouter, unauthorizedError } from '@dotpress/core'
import { createTestApp } from '@dotpress/testing'
import jwt from 'jsonwebtoken'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AUTH_SECURITY_SCHEMES,
  authPlugin,
  createAuth,
  requireAuth,
  requireClient,
  requireRole,
  type AuthSession,
  type AuthUser,
} from '../src/index.js'
import {
  ACCESS_COOKIE,
  cookieHeader,
  createAuthApp,
  createStore,
  keys,
  login,
  postJson,
  REFRESH_COOKIE,
} from './support.js'

const whoAmI = (router: ReturnType<typeof createRouter>) => {
  router.defineRoute({
    method: 'post',
    path: '/whoami',
    handler: ({ user, auth }) => ({
      user: user?.id ?? null,
      roles: auth?.roles,
    }),
  })
}

describe('authPlugin()', () => {
  describe('authentication', () => {
    it('reads the bearer token, then the cookie', async () => {
      const { fetch } = await createAuthApp({
        settings: { cookies: { enabled: true, accessTokenInCookie: true } },
        routes: whoAmI,
      })
      const { body: tokens } = await login(fetch)
      const whoami = async (init: RequestInit) =>
        (await fetch('/whoami', { method: 'POST', ...init })).json()

      expect(await whoami({})).toEqual({ user: null })
      expect(
        await whoami({
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        })
      ).toEqual({ user: 'u1', roles: ['admin'] })
      expect(
        await whoami({
          headers: {
            cookie: cookieHeader({ [ACCESS_COOKIE]: tokens.accessToken }),
          },
        })
      ).toEqual({ user: 'u1', roles: ['admin'] })
    })

    it('accepts the bearer scheme in any letter case', async () => {
      const { fetch } = await createAuthApp({ routes: whoAmI })
      const { body: tokens } = await login(fetch)
      const whoami = async (authorization: string) =>
        (
          await fetch('/whoami', { method: 'POST', headers: { authorization } })
        ).json()

      for (const scheme of ['bearer', 'BEARER', 'Bearer ']) {
        expect(await whoami(`${scheme} ${tokens.accessToken}`)).toMatchObject({
          user: 'u1',
        })
      }
      for (const header of [
        `Bearer${tokens.accessToken}`,
        `Bearer ${tokens.accessToken} extra`,
        `Basic ${tokens.accessToken}`,
      ]) {
        expect(await whoami(header)).toEqual({ user: null })
      }
    })

    it('never reads the access token from the body', async () => {
      const { fetch, logger } = await createAuthApp({
        settings: { cookies: { enabled: true, accessTokenInCookie: true } },
        routes: (router) => {
          // App route receiving a token of its own.
          router.defineRoute({
            method: 'post',
            path: '/integrations',
            schema: (z) => ({ body: z.object({ accessToken: z.string() }) }),
            handler: ({ req, user }) => ({
              received: req.body.accessToken,
              user: user?.id ?? null,
            }),
          })
        },
      })
      const { body: tokens } = await login(fetch)

      for (const accessToken of [tokens.accessToken, 'third-party-token']) {
        const res = await fetch('/integrations', postJson({ accessToken }))
        expect(await res.json()).toEqual({ received: accessToken, user: null })
      }
      expect(
        logger.entries.some((entry) => entry.args[1] === 'Invalid access token')
      ).toBe(false)
    })

    it('ignores the access token cookie unless configured', async () => {
      const { fetch } = await createAuthApp({ routes: whoAmI })
      const { body: tokens } = await login(fetch)

      const res = await fetch('/whoami', {
        method: 'POST',
        headers: {
          cookie: cookieHeader({ [ACCESS_COOKIE]: tokens.accessToken }),
        },
      })

      expect(await res.json()).toEqual({ user: null })
    })

    it('treats invalid, expired and orphan tokens as anonymous', async () => {
      const { fetch, logger, auth } = await createAuthApp({ routes: whoAmI })
      const expired = jwt.sign({ username: 'ada' }, keys.secretKey, {
        algorithm: 'RS256',
        subject: 'u1',
        expiresIn: -10,
      })
      // Valid token of a user that no longer exists.
      const { accessToken: orphan } = await auth.generateAccessToken({
        userId: 'u404',
        username: 'ghost',
      })

      for (const token of ['garbage', expired, orphan]) {
        const res = await fetch('/whoami', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        })
        expect(await res.json()).toEqual({ user: null })
      }

      expect(
        logger.entries.filter(
          (entry) => entry.args[1] === 'Invalid access token'
        )
      ).toHaveLength(2)
    })
  })

  describe('WWW-Authenticate', () => {
    it('challenges the 401 responses (RFC 6750)', async () => {
      const { fetch, auth } = await createAuthApp()
      const { body: tokens } = await login(fetch)
      const { accessToken: orphan } = await auth.generateAccessToken({
        userId: 'u404',
      })
      const me = (headers: Record<string, string> = {}) =>
        fetch('/auth/me', { headers })

      const anonymous = await me()
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get('www-authenticate')).toBe('Bearer')
      for (const token of ['garbage', orphan]) {
        expect(
          (await me({ authorization: `Bearer ${token}` })).headers.get(
            'www-authenticate'
          )
        ).toBe('Bearer error="invalid_token"')
      }
      const ok = await me({ authorization: `Bearer ${tokens.accessToken}` })
      expect(ok.status).toBe(200)
      expect(ok.headers.get('www-authenticate')).toBeNull()

      const failedLogin = await fetch(
        '/auth/login',
        postJson({ username: 'ada', password: 'wrong' })
      )
      expect(failedLogin.headers.get('www-authenticate')).toBe('Bearer')
    })

    it('does not report invalid_token for cookies', async () => {
      const { fetch } = await createAuthApp({
        settings: { cookies: { enabled: true, accessTokenInCookie: true } },
      })

      const res = await fetch('/auth/me', {
        headers: { cookie: cookieHeader({ [ACCESS_COOKIE]: 'garbage' }) },
      })

      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
    })

    it('keeps a challenge set by the app', async () => {
      const { fetch } = await createAuthApp({
        routes: (router) => {
          router.defineRoute({
            path: '/partners',
            handler: ({ res }) => {
              res.setHeader('www-authenticate', 'ApiKey')
              return unauthorizedError()
            },
          })
        },
      })

      const res = await fetch('/partners')

      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('ApiKey')
    })
  })

  describe('cross-site request forgery', () => {
    const TRUSTED = 'https://app.example.com'
    const routes = (router: ReturnType<typeof createRouter>) => {
      whoAmI(router)
      router.defineRoute({
        path: '/whoami',
        handler: ({ user }) => ({ user: user?.id ?? null }),
      })
    }

    const setup = async () => {
      const app = await createAuthApp({
        settings: {
          cookies: {
            enabled: true,
            accessTokenInCookie: true,
            trustedOrigins: [TRUSTED],
          },
        },
        routes,
      })
      const { body } = await login(app.fetch)
      const cookie = cookieHeader({
        [ACCESS_COOKIE]: body.accessToken,
        [REFRESH_COOKIE]: body.refreshToken,
      })
      const whoami = async (
        headers: Record<string, string>,
        method = 'POST'
      ) => {
        const res = await app.fetch('/whoami', {
          method,
          headers: { cookie, ...headers },
        })
        return ((await res.json()) as { user: string | null }).user
      }
      return { ...app, body, cookie, whoami }
    }

    it.each([
      ['same origin', { 'sec-fetch-site': 'same-origin' }],
      ['typed URL or bookmark', { 'sec-fetch-site': 'none' }],
      ['trusted origin', { 'sec-fetch-site': 'same-site', origin: TRUSTED }],
      ['non-browser client', {}],
      ['older browser, same host', { origin: 'http://localhost' }],
    ])('authenticates cookie requests: %s', async (_label, headers) => {
      const { whoami } = await setup()
      expect(await whoami(headers)).toBe('u1')
    })

    it.each([
      [
        'another site',
        { 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' },
      ],
      [
        'another subdomain',
        { 'sec-fetch-site': 'same-site', origin: 'https://evil.example.com' },
      ],
      ['older browser, another host', { origin: 'https://evil.com' }],
      ['opaque origin', { origin: 'null' }],
    ])(
      'ignores the cookie of cross-origin requests: %s',
      async (_label, headers) => {
        const { whoami, logger } = await setup()

        expect(await whoami(headers)).toBeNull()
        expect(
          logger.entries.some((entry) =>
            String(entry.args[1]).startsWith('Access token cookie ignored')
          )
        ).toBe(true)
      }
    )

    it('does not check safe methods, nor bearer tokens', async () => {
      const { whoami, body } = await setup()
      const crossSite = {
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.com',
      }

      expect(await whoami(crossSite, 'GET')).toBe('u1')
      expect(
        await whoami({
          ...crossSite,
          authorization: `Bearer ${body.accessToken}`,
        })
      ).toBe('u1')
    })

    it('rejects cross-origin refresh and restore with cookies', async () => {
      const { fetch, cookie } = await setup()
      const crossSite = {
        cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.com',
      }

      for (const path of ['/auth/refresh', '/auth/restore']) {
        const res = await fetch(path, { method: 'POST', headers: crossSite })
        expect(res.status).toBe(403)
        expect(await res.json()).toMatchObject({
          message: 'CROSS_ORIGIN_REQUEST',
        })
      }

      const trusted = await fetch('/auth/refresh', {
        method: 'POST',
        headers: { ...crossSite, origin: TRUSTED },
      })
      expect(trusted.status).toBe(200)
    })

    it('does not check refreshes in body mode', async () => {
      const { fetch, body } = await setup()

      const res = await fetch(
        '/auth/refresh',
        postJson(
          { accessToken: body.accessToken, refreshToken: body.refreshToken },
          { 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' }
        )
      )

      expect(res.status).toBe(200)
    })

    it('rejects invalid trusted origins', () => {
      for (const origin of ['app.example.com', 'https://app.example.com/']) {
        expect(() =>
          createAuth({
            keys,
            dataProvider: createStore().provider,
            issuer: 'https://api.example.com',
            cookies: { trustedOrigins: [origin] },
          })
        ).toThrow('Invalid cookies.trustedOrigins')
      }
    })
  })

  describe('requireAuth and requireRole()', () => {
    const guarded = (router: ReturnType<typeof createRouter>) => {
      router.defineRoute({
        path: '/profile',
        middlewares: [requireAuth],
        handler: ({ user, auth }) => {
          expectTypeOf(user).toEqualTypeOf<AuthUser>()
          expectTypeOf(auth).toEqualTypeOf<AuthSession>()
          return { id: user.id }
        },
      })
      router.createGroup('/admin', [requireRole('admin')]).defineRoute({
        path: '/stats',
        handler: ({ user }) => ({ admin: user.username }),
      })
      router.defineRoute({
        path: '/staff',
        middlewares: [requireRole('admin', 'user')],
        handler: ({ user }) => ({ staff: user.username }),
      })
    }

    it('require an authenticated user, and the roles', async () => {
      const { fetch } = await createAuthApp({ routes: guarded })
      const ada = (await login(fetch)).body.accessToken
      const linus = (
        await login(fetch, { username: 'linus', password: 'secret' })
      ).body.accessToken
      const as = (token: string) => ({
        headers: { authorization: `Bearer ${token}` },
      })

      expect((await fetch('/profile')).status).toBe(401)
      expect(await (await fetch('/profile', as(ada))).json()).toEqual({
        id: 'u1',
      })

      expect((await fetch('/admin/stats')).status).toBe(401)
      expect((await fetch('/admin/stats', as(linus))).status).toBe(403)
      expect(await (await fetch('/admin/stats', as(ada))).json()).toEqual({
        admin: 'ada',
      })

      expect(await (await fetch('/staff', as(linus))).json()).toEqual({
        staff: 'linus',
      })
    })

    it('read roles with the getUserRoles setting', async () => {
      const { fetch } = await createAuthApp({
        settings: {
          getUserRoles: (user) => (user.id === 'u2' ? ['admin'] : []),
        },
        routes: guarded,
      })
      const linus = (
        await login(fetch, { username: 'linus', password: 'secret' })
      ).body.accessToken

      expect(
        (
          await fetch('/admin/stats', {
            headers: { authorization: `Bearer ${linus}` },
          })
        ).status
      ).toBe(200)
    })

    it('rejects empty role lists', () => {
      // @ts-expect-error at least one role is required
      expect(() => requireRole()).toThrow('at least one role')
    })
  })

  describe('requireClient()', () => {
    const backoffice = (router: ReturnType<typeof createRouter>) => {
      router
        .createGroup('/backoffice', [requireClient('backoffice')])
        .defineRoute({
          path: '/stats',
          handler: ({ user, auth }) => {
            expectTypeOf(user).toEqualTypeOf<AuthUser>()
            return { client: auth.clientId }
          },
        })
    }

    it('requires a token issued for one of the clients', async () => {
      const { fetch } = await createAuthApp({
        settings: { clients: { allowed: ['app', 'backoffice'] } },
        routes: backoffice,
      })
      const tokenFor = async (clientId?: string) =>
        (
          await login(fetch, {
            username: 'ada',
            password: 'secret',
            ...(clientId && { clientId }),
          })
        ).body.accessToken
      const as = (token: string) => ({
        headers: { authorization: `Bearer ${token}` },
      })

      expect((await fetch('/backoffice/stats')).status).toBe(401)
      expect(
        (await fetch('/backoffice/stats', as(await tokenFor('app')))).status
      ).toBe(403)
      expect(
        (await fetch('/backoffice/stats', as(await tokenFor()))).status
      ).toBe(403)
      expect(
        await (
          await fetch('/backoffice/stats', as(await tokenFor('backoffice')))
        ).json()
      ).toEqual({ client: 'backoffice' })
    })

    it('rejects empty client lists', () => {
      // @ts-expect-error at least one client is required
      expect(() => requireClient()).toThrow('at least one client')
    })
  })

  describe('setup', () => {
    it('fails at startup on invalid keys', async () => {
      const auth = createAuth({
        keys: { secretKey: 'invalid', publicKey: keys.publicKey },
        dataProvider: createStore().provider,
        issuer: 'https://api.example.com',
      })

      await expect(
        createTestApp({ routers: [], plugins: [authPlugin(auth)] })
      ).rejects.toThrow('Invalid auth secretKey')
    })

    it('exposes the service and the security schemes to other plugins', () => {
      const auth = createAuth({
        keys,
        dataProvider: createStore().provider,
        issuer: 'https://api.example.com',
      })
      const plugin = authPlugin(auth)

      expect(plugin.name).toBe('auth')
      expect(plugin.auth).toBe(auth)
      expect(plugin.securitySchemes).toBe(AUTH_SECURITY_SCHEMES)
    })

    it('makes ctx.user fail explicitly when the plugin is not installed', async () => {
      const router = createRouter()
      router.defineRoute({ path: '/me', handler: ({ user }) => ({ user }) })

      const { fetch, logger } = await createTestApp({ routers: [router] })

      expect((await fetch('/me')).status).toBe(500)
      expect(logger.entries).toContainEqual({
        level: 'error',
        args: [
          expect.objectContaining({
            message:
              '"ctx.user" is used, but the "authPlugin" plugin is not installed in createApp().',
          }),
          'Unhandled error while processing request',
        ],
      })
    })

    it('types ctx.user as optional outside of guarded routes', () => {
      createRouter().defineRoute({
        path: '/optional',
        handler: ({ user, auth }) => {
          expectTypeOf(user).toEqualTypeOf<AuthUser | undefined>()
          expectTypeOf(auth).toEqualTypeOf<AuthSession | undefined>()
        },
      })
    })
  })
})
