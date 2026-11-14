import { afterEach, describe, expect, it } from 'vitest'
import {
  createApp,
  createRouteGroup,
  createRouter,
  defineRoute,
  globalRouter,
  type Middleware,
} from '../src/index.js'
import { getRouterState } from '../src/routes.js'
import { HTTP_METHODS } from '../src/http.js'
import {
  createTestApp,
  memoryAdapter,
  silentLogger,
} from './support/memory-adapter.js'

describe('routing', () => {
  it('handles GET routes by default and serializes the result as JSON', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({ path: '/hello', handler: () => ({ message: 'hi' }) })
    })

    const res = await inject({ url: '/hello' })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(res.body).toEqual({ message: 'hi' })
  })

  it.each(HTTP_METHODS)('routes %s requests', async (method) => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method,
        path: '/resource',
        handler: () => ({ method }),
      })
    })

    const res = await inject({ method, url: '/resource' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ method })
  })

  it('exposes path parameters and the uppercase method', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'put',
        path: '/orgs/:orgId/members/:id',
        handler: ({ req }) => ({
          method: req.method,
          orgId: req.params.orgId,
          id: req.params.id,
        }),
      })
    })

    const res = await inject({ method: 'PUT', url: '/orgs/acme/members/42' })

    expect(res.body).toEqual({ method: 'PUT', orgId: 'acme', id: '42' })
  })

  it('returns a standard 404 error when no route matches', async () => {
    const { inject } = await createTestApp(() => {})

    const res = await inject({ url: '/missing' })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({
      status: 404,
      error: 'NOT_FOUND',
      message: 'Route not found',
    })
    expect(res.headers['x-request-id']).toEqual(expect.any(String))
  })

  it('returns 405 with an Allow header when the path exists for other methods', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({ path: '/items', handler: () => [] })
      router.defineRoute({
        method: 'post',
        path: '/items',
        handler: () => null,
      })
    })

    for (const method of ['PUT', 'OPTIONS']) {
      const res = await inject({ method, url: '/items' })

      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('GET, HEAD, POST')
      expect(res.headers['x-request-id']).toEqual(expect.any(String))
      expect(res.body).toEqual({
        status: 405,
        error: 'METHOD_NOT_ALLOWED',
        message: 'Method not allowed',
      })
    }
  })

  describe('groups', () => {
    it('applies prefixes and middlewares to nested groups', async () => {
      const calls: string[] = []
      const track =
        (name: string): Middleware =>
        () => {
          calls.push(name)
        }

      const { inject } = await createTestApp((router) => {
        const v1 = router.createGroup('/v1', [track('v1')])
        const admin = v1.createGroup('/admin/', [track('admin')])

        admin.defineRoute({
          path: '/users',
          middlewares: [track('route')],
          handler: () => {
            calls.push('handler')
            return { ok: true }
          },
        })
        v1.defineRoute({ path: '/', handler: () => ({ root: true }) })
      })

      expect((await inject({ url: '/v1/admin/users' })).body).toEqual({
        ok: true,
      })
      expect(calls).toEqual(['v1', 'admin', 'route', 'handler'])
      expect((await inject({ url: '/v1' })).body).toEqual({ root: true })
    })

    it('exposes the normalized group prefix', () => {
      const router = createRouter()
      const group = router
        .createGroup('/orgs/:orgId/')
        .createGroup('/projects//')

      expect(group.prefix).toBe('/orgs/:orgId/projects')
      expect(() => router.createGroup('projects')).toThrow(
        'must start with "/"'
      )
    })
  })

  describe('definition errors', () => {
    it('rejects invalid paths', () => {
      const router = createRouter()

      expect(() =>
        router.defineRoute({ path: 'users', handler: () => null })
      ).toThrow('must start with "/"')
      expect(() =>
        router.defineRoute({ path: '/files/*', handler: () => null })
      ).toThrow('Unsupported path syntax')
      expect(() =>
        router.defineRoute({ path: '/users/:user-id', handler: () => null })
      ).toThrow('Invalid path parameter')
    })

    it('rejects unknown methods and invalid statuses', () => {
      const router = createRouter()

      expect(() =>
        // @ts-expect-error unsupported method
        router.defineRoute({ method: 'trace', path: '/', handler: () => null })
      ).toThrow('Unsupported HTTP method')
      expect(() =>
        router.defineRoute({ path: '/', status: 99, handler: () => null })
      ).toThrow('Invalid status')
    })

    it('rejects conflicting routes, regardless of parameter names', async () => {
      const router = createRouter()
      router.defineRoute({ path: '/users/:id', handler: () => null })
      router.defineRoute({ path: '/users/:userId', handler: () => null })

      await expect(
        createApp({ adapter: memoryAdapter(), routers: [router] })
      ).rejects.toThrow('Route conflict: "GET /users/:userId"')
    })

    it('allows the same path with different methods', async () => {
      const router = createRouter()
      router.defineRoute({ path: '/users', handler: () => null })
      router.defineRoute({
        method: 'post',
        path: '/users',
        handler: () => null,
      })

      await expect(
        createApp({ adapter: memoryAdapter(), routers: [router] })
      ).resolves.toBeDefined()
    })
  })

  describe('routers', () => {
    afterEach(() => globalRouter.clear())

    it('isolates routes between routers', async () => {
      const first = await createTestApp((router) => {
        router.defineRoute({ path: '/first', handler: () => 'first' })
      })
      const second = await createTestApp((router) => {
        router.defineRoute({ path: '/second', handler: () => 'second' })
      })

      expect((await first.inject({ url: '/second' })).status).toBe(404)
      expect((await second.inject({ url: '/first' })).status).toBe(404)
    })

    it('mounts several routers', async () => {
      const users = createRouter()
      const posts = createRouter()
      users.defineRoute({ path: '/users', handler: () => 'users' })
      posts.defineRoute({ path: '/posts', handler: () => 'posts' })

      const adapter = memoryAdapter()
      await createApp({
        adapter,
        routers: [users, posts],
        logger: silentLogger(),
      })

      expect((await adapter.inject({ url: '/users' })).body).toBe('users')
      expect((await adapter.inject({ url: '/posts' })).body).toBe('posts')
    })

    it('uses the global router by default', async () => {
      defineRoute({ path: '/global', handler: () => ({ global: true }) })
      createRouteGroup('/api').defineRoute({
        path: '/ping',
        handler: () => 'pong',
      })

      const adapter = memoryAdapter()
      await createApp({ adapter, logger: silentLogger() })

      expect((await adapter.inject({ url: '/global' })).body).toEqual({
        global: true,
      })
      expect((await adapter.inject({ url: '/api/ping' })).body).toBe('pong')
    })

    it('can be cleared', () => {
      const router = createRouter()
      router.defineRoute({ path: '/', handler: () => null })
      router.addResponseFilter((_ctx, result) => result)

      router.clear()

      expect(getRouterState(router)).toEqual({ routes: [], filters: [] })
    })
  })

  describe('app', () => {
    it('exposes route introspection data', async () => {
      const { app } = await createTestApp((router) => {
        router.defineRoute({
          method: 'post',
          path: '/orgs/:orgId/members',
          status: 201,
          meta: { summary: 'Create a member', tags: ['members'] },
          schema: (z) => ({ body: z.object({ name: z.string() }) }),
          handler: () => ({ id: '1' }),
        })
      })

      const [route] = app.routes

      expect(route).toMatchObject({
        method: 'post',
        path: '/orgs/:orgId/members',
        pathParams: ['orgId'],
        status: 201,
        meta: { summary: 'Create a member', tags: ['members'] },
      })
      expect(route?.schema.body).toBeDefined()
    })

    it('delegates native(), listen() and close() to the adapter', async () => {
      const adapter = memoryAdapter()
      const app = await createApp({ adapter, routers: [createRouter()] })

      expect(app.native()).toEqual({ routes: [] })
      await expect(app.listen(3000)).rejects.toThrow(
        'The "memory" adapter does not support listen()'
      )
      await expect(app.close()).resolves.toBeUndefined()
    })

    it('requires an adapter', async () => {
      // @ts-expect-error missing adapter
      await expect(createApp({})).rejects.toThrow('requires an HTTP adapter')
    })
  })
})
