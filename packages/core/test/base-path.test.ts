import { describe, expect, it } from 'vitest'
import {
  createApp,
  createRouter,
  definePlugin,
  redirect,
  type PluginAPI,
} from '../src/index.js'
import {
  createTestApp,
  memoryAdapter,
  silentLogger,
} from './support/memory-adapter.js'

const pluginRoutes = (onSetup?: (api: PluginAPI) => void) =>
  definePlugin({
    name: 'health',
    setup(api) {
      onSetup?.(api)
      api.addRoute({ path: '/health', handler: () => ({ status: 'ok' }) })
    },
  })

describe('base path', () => {
  describe('basePath', () => {
    it('prefixes app and plugin routes', async () => {
      const { app, inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/users/:id',
            handler: ({ req }) => ({ id: req.params.id, path: req.path }),
          })
          router.createGroup('/admin').defineRoute({
            path: '/stats',
            handler: () => ({ ok: true }),
          })
        },
        { basePath: '/my-app/api', plugins: [pluginRoutes()] }
      )

      const user = await inject({ url: '/my-app/api/users/42' })
      expect(user.status).toBe(200)
      // The request path is the full path.
      expect(user.body).toEqual({ id: '42', path: '/my-app/api/users/42' })

      expect((await inject({ url: '/my-app/api/admin/stats' })).body).toEqual({
        ok: true,
      })
      expect((await inject({ url: '/my-app/api/health' })).body).toEqual({
        status: 'ok',
      })

      expect(app.routes.map((route) => route.path)).toEqual([
        '/my-app/api/users/:id',
        '/my-app/api/admin/stats',
        '/my-app/api/health',
      ])
      expect(app.routes[0]?.pathParams).toEqual(['id'])
    })

    it('returns 404 outside of the base path', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({ path: '/users', handler: () => [] })
        },
        { basePath: '/api' }
      )

      for (const url of ['/users', '/', '/other/users', '/apiusers']) {
        const res = await inject({ url })
        expect(res.status, url).toBe(404)
      }
      expect((await inject({ url: '/api/users' })).status).toBe(200)
    })

    it('serves a root route at the base path', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({ path: '/', handler: () => ({ root: true }) })
        },
        { basePath: '/api' }
      )

      expect((await inject({ url: '/api' })).body).toEqual({ root: true })
      expect((await inject({ url: '/api/' })).body).toEqual({ root: true })
    })

    it('detects conflicts on full paths', async () => {
      const router = createRouter()
      router.defineRoute({ path: '/users', handler: () => [] })
      const plugin = definePlugin({
        name: 'users',
        setup(api) {
          api.addRoute({ path: '/users', handler: () => [] })
        },
      })

      await expect(
        createApp({
          adapter: memoryAdapter(),
          logger: silentLogger(),
          routers: [router],
          plugins: [plugin],
          basePath: '/api',
        })
      ).rejects.toThrow('Route conflict: "GET /api/users"')
    })

    it('normalizes the base path', async () => {
      for (const [basePath, expected] of [
        ['/api/', '/api'],
        ['//my-app//api', '/my-app/api'],
        ['/', ''],
      ] as const) {
        const { app } = await createTestApp(
          (router) => {
            router.defineRoute({ path: '/users', handler: () => [] })
          },
          { basePath }
        )

        expect(app.basePath).toBe(expected)
        expect(app.routes[0]?.path).toBe(`${expected}/users`)
      }
    })

    it.each([
      ['api', 'expected a path starting with "/"'],
      ['', 'expected a path starting with "/"'],
      ['/api/:tenant', 'cannot contain parameters'],
      ['/api/*', 'Unsupported path syntax'],
      ['/api?x=1', 'Unsupported path syntax'],
    ])('rejects %j', async (basePath, message) => {
      await expect(createTestApp(() => {}, { basePath })).rejects.toThrow(
        message
      )
    })

    it('rejects non-string values', async () => {
      await expect(
        // @ts-expect-error invalid type
        createTestApp(() => {}, { basePath: 42 })
      ).rejects.toThrow('Invalid basePath')
    })
  })

  describe('publicBasePath', () => {
    it('does not prefix routes', async () => {
      const { app, inject } = await createTestApp(
        (router) => {
          router.defineRoute({ path: '/users', handler: () => [] })
        },
        { publicBasePath: '/my-app/api/', plugins: [pluginRoutes()] }
      )

      expect((await inject({ url: '/users' })).status).toBe(200)
      expect((await inject({ url: '/health' })).status).toBe(200)
      expect((await inject({ url: '/my-app/api/users' })).status).toBe(404)
      expect(app.routes.map((route) => route.path)).toEqual([
        '/users',
        '/health',
      ])
      expect(app.publicBasePath).toBe('/my-app/api')
      expect(app.basePath).toBe('')
    })

    it('is validated like basePath', async () => {
      await expect(
        createTestApp(() => {}, { publicBasePath: '/:app' })
      ).rejects.toThrow('Invalid publicBasePath "/:app"')
    })

    it('cannot be combined with basePath', async () => {
      await expect(
        createTestApp(() => {}, { basePath: '/a', publicBasePath: '/a' })
      ).rejects.toThrow('basePath and publicBasePath cannot be combined')
    })
  })

  describe('publicPath()', () => {
    const cases = [
      [{}, '/login', '/login'],
      [{}, '/', '/'],
      [{ basePath: '/api' }, '/login', '/api/login'],
      [{ basePath: '/api' }, '/', '/api'],
      [{ basePath: '/api' }, '/login?next=%2F#top', '/api/login?next=%2F#top'],
      [{ publicBasePath: '/my-app/api' }, '/auth', '/my-app/api/auth'],
      [{ basePath: '/' }, '/login', '/login'],
    ] as const

    it.each(cases)('with %j: %s -> %s', async (options, path, expected) => {
      const { app } = await createTestApp(() => {}, options)
      expect(app.publicPath(path)).toBe(expected)
    })

    it('rejects relative paths', async () => {
      const { app } = await createTestApp(() => {}, { basePath: '/api' })
      expect(() => app.publicPath('login')).toThrow(
        'publicPath() expects a path starting with "/", received "login"'
      )
    })

    it('is available to plugins during setup', async () => {
      let seen: unknown
      await createTestApp(() => {}, {
        publicBasePath: '/my-app',
        plugins: [
          pluginRoutes((api) => {
            seen = {
              basePath: api.basePath,
              publicBasePath: api.publicBasePath,
              path: api.publicPath('/auth'),
            }
          }),
        ],
      })

      expect(seen).toEqual({
        basePath: '',
        publicBasePath: '/my-app',
        path: '/my-app/auth',
      })
    })

    it('is available in the context, for redirects', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/old',
            handler: (ctx) => redirect(ctx.publicPath('/new')),
          })
        },
        { basePath: '/api' }
      )

      const res = await inject({ url: '/api/old' })
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe('/api/new')
    })

    it('does not prefix redirects automatically', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({ path: '/old', handler: () => redirect('/new') })
        },
        { publicBasePath: '/api' }
      )

      expect((await inject({ url: '/old' })).headers.location).toBe('/new')
    })

    it('is a reserved context key', async () => {
      await expect(
        createTestApp(() => {}, {
          plugins: [
            definePlugin({
              name: 'paths',
              setup(api) {
                // @ts-expect-error reserved key
                api.decorateContext('publicPath', () => () => '')
              },
            }),
          ],
        })
      ).rejects.toThrow('reserved context key "publicPath"')
    })
  })
})
