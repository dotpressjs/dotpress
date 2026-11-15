import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import {
  createRouter,
  defineMiddleware,
  definePlugin,
  forbiddenError,
  type Middleware,
  type Plugin,
} from '../src/index.js'
import { createTestApp } from './support/memory-adapter.js'

const bearer = defineMiddleware(() => undefined, { security: ['bearerAuth'] })

/** Security requirements of the single route `/r`, with these middlewares. */
const securityOf = async (
  middlewares: Middleware[],
  options: { global?: Middleware[]; security?: string[] } = {}
) => {
  const { app } = await createTestApp(
    (router) => {
      router.defineRoute({
        path: '/r',
        middlewares,
        meta: options.security && { security: options.security },
        handler: () => ({}),
      })
    },
    { middlewares: options.global }
  )
  return app.routes[0]?.security
}

describe('documentation metadata', () => {
  describe('defineMiddleware() security', () => {
    it('returns the middleware itself without options', () => {
      const middleware = () => undefined
      expect(defineMiddleware(middleware)).toBe(middleware)
      expect(defineMiddleware(middleware, {})).toBe(middleware)
    })

    it('returns a copy that runs the middleware', async () => {
      const calls: string[] = []
      const middleware = () => {
        calls.push('called')
        return forbiddenError()
      }
      const declared = defineMiddleware(middleware, { security: ['apiKey'] })

      expect(declared).not.toBe(middleware)
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/r',
          middlewares: [declared],
          handler: () => ({}),
        })
      })

      expect((await inject({ url: '/r' })).status).toBe(403)
      expect(calls).toEqual(['called'])
    })

    it.each([
      [{ security: 'bearerAuth' }],
      [{ security: [''] }],
      [{ security: [42] }],
    ])('rejects invalid security (%j)', (options) => {
      expect(() =>
        // @ts-expect-error invalid options
        defineMiddleware(() => undefined, options)
      ).toThrow('Invalid middleware security')
    })
  })

  describe('route security', () => {
    it('is empty without secured middleware', async () => {
      expect(await securityOf([() => undefined])).toEqual([])
    })

    it('comes from route, group and global middlewares', async () => {
      expect(await securityOf([bearer])).toEqual([['bearerAuth']])
      expect(await securityOf([], { global: [bearer] })).toEqual([
        ['bearerAuth'],
      ])

      const { app } = await createTestApp(
        (router) => {
          router
            .createGroup('/admin', [bearer])
            .defineRoute({ path: '/stats', handler: () => ({}) })
        },
        {
          plugins: [
            definePlugin({
              name: 'keys',
              setup(api) {
                api.addGlobalMiddleware(
                  defineMiddleware(() => undefined, { security: ['apiKey'] })
                )
              },
            }),
          ],
        }
      )
      expect(app.routes[0]?.security).toEqual([['apiKey', 'bearerAuth']])
    })

    it('requires every middleware, each accepting any of its schemes', async () => {
      const tokens = defineMiddleware(() => undefined, {
        security: ['bearerAuth', 'cookieAuth'],
      })
      const apiKey = defineMiddleware(() => undefined, { security: ['apiKey'] })

      expect(await securityOf([tokens, apiKey])).toEqual([
        ['bearerAuth', 'apiKey'],
        ['cookieAuth', 'apiKey'],
      ])
    })

    it('removes duplicates', async () => {
      const role = defineMiddleware(() => undefined, {
        security: ['bearerAuth'],
      })
      const either = defineMiddleware(() => undefined, {
        security: ['apiKey', 'bearerAuth'],
      })

      expect(await securityOf([bearer, role])).toEqual([['bearerAuth']])
      // (apiKey or bearerAuth) and bearerAuth: bearerAuth.
      expect(await securityOf([bearer, either])).toEqual([['bearerAuth']])
      expect(await securityOf([either, bearer, either])).toEqual([
        ['bearerAuth'],
      ])
      const apiKey = defineMiddleware(() => undefined, { security: ['apiKey'] })
      expect(await securityOf([apiKey, bearer, either])).toEqual([
        ['apiKey', 'bearerAuth'],
      ])
      expect(await securityOf([either, either])).toEqual([
        ['apiKey'],
        ['bearerAuth'],
      ])
    })

    it('ignores middlewares declaring no scheme', async () => {
      const none = defineMiddleware(() => undefined, { security: [] })
      expect(await securityOf([none])).toEqual([])
      expect(await securityOf([none, bearer])).toEqual([['bearerAuth']])
    })

    it('is overridden by meta.security', async () => {
      expect(await securityOf([bearer], { security: [] })).toEqual([])
      expect(
        await securityOf([bearer], { security: ['apiKey', 'cookieAuth'] })
      ).toEqual([['apiKey'], ['cookieAuth']])
    })
  })

  describe('meta.responses', () => {
    it('is exposed in the route metadata', async () => {
      const conflict = z.object({ id: z.string() })
      const { app } = await createTestApp((router) => {
        router.defineRoute({
          path: '/r',
          meta: {
            responses: {
              404: 'Not found',
              409: { description: 'Conflict', schema: conflict },
            },
          },
          handler: () => ({}),
        })
      })

      expect(app.routes[0]?.meta.responses).toEqual({
        404: 'Not found',
        409: { description: 'Conflict', schema: conflict },
      })
    })

    it.each([
      [{ 42: 'Too low' }, 'Route "/r": invalid status "42" in meta.responses'],
      [{ 600: 'Too high' }, 'invalid status "600"'],
      [{ abc: 'Not a status' }, 'invalid status "abc"'],
      [{ 404: {} }, 'Route "/r": meta.responses[404] needs a description'],
      [{ 404: null }, 'Route "/r": meta.responses[404] needs a description'],
    ])('rejects %j', (responses, message) => {
      const router = createRouter()
      expect(() =>
        router.defineRoute({
          path: '/r',
          // @ts-expect-error invalid responses
          meta: { responses },
          handler: () => ({}),
        })
      ).toThrow(message)
    })
  })

  describe('api.getPlugins() and app.plugins', () => {
    it('lists the plugins in setup order', async () => {
      let names: string[] = []
      const plugin = (name: string, dependsOn?: string[]): Plugin =>
        definePlugin({
          name,
          dependsOn,
          setup(api) {
            names = api.getPlugins().map((item) => item.name)
          },
        })

      const { app } = await createTestApp(() => {}, {
        plugins: [plugin('docs', ['auth']), plugin('auth')],
      })

      expect(names).toEqual(['auth', 'docs'])
      expect(app.plugins.map((item) => item.name)).toEqual(['auth', 'docs'])
    })
  })
})
