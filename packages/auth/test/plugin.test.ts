import { createRouter } from '@dotpress/core'
import { createTestApp } from '@dotpress/testing'
import jwt from 'jsonwebtoken'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AUTH_SECURITY_SCHEMES,
  authPlugin,
  createAuth,
  requireAuth,
  requireRole,
  type AuthSession,
  type AuthUser,
} from '../src/index.js'
import {
  cookieHeader,
  createAuthApp,
  createStore,
  keys,
  login,
  postJson,
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
    it('reads the bearer token, then the cookie, then the body', async () => {
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
            cookie: cookieHeader({ dotpress_access_token: tokens.accessToken }),
          },
        })
      ).toEqual({ user: 'u1', roles: ['admin'] })
      expect(
        await whoami(postJson({ accessToken: tokens.accessToken }))
      ).toEqual({ user: 'u1', roles: ['admin'] })
    })

    it('ignores the access token cookie unless configured', async () => {
      const { fetch } = await createAuthApp({ routes: whoAmI })
      const { body: tokens } = await login(fetch)

      const res = await fetch('/whoami', {
        method: 'POST',
        headers: {
          cookie: cookieHeader({ dotpress_access_token: tokens.accessToken }),
        },
      })

      expect(await res.json()).toEqual({ user: null })
    })

    it('treats invalid, expired and orphan tokens as anonymous', async () => {
      const { fetch, logger, store } = await createAuthApp({ routes: whoAmI })
      const expired = jwt.sign({ username: 'ada' }, keys.secretKey, {
        algorithm: 'RS256',
        subject: 'u1',
        expiresIn: -10,
      })
      const orphan = jwt.sign({ username: 'ghost' }, keys.secretKey, {
        algorithm: 'RS256',
        subject: 'u404',
        expiresIn: 60,
      })
      void store

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

  describe('setup', () => {
    it('fails at startup on invalid keys', async () => {
      const auth = createAuth({
        keys: { secretKey: 'invalid', publicKey: keys.publicKey },
        dataProvider: createStore().provider,
      })

      await expect(
        createTestApp({ routers: [], plugins: [authPlugin(auth)] })
      ).rejects.toThrow('Invalid auth secretKey')
    })

    it('exposes the service and the security schemes to other plugins', () => {
      const auth = createAuth({ keys, dataProvider: createStore().provider })
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
