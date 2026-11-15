import { describe, expect, it, vi } from 'vitest'
import {
  defineMiddleware,
  redirect,
  unauthorizedError,
  type Middleware,
} from '../src/index.js'
import { createTestApp } from './support/memory-adapter.js'

declare module '../src/index.js' {
  interface RequestContext {
    currentUser?: { id: string }
  }
}

const requireUser: Middleware = (ctx) => {
  if (ctx.req.header('authorization') !== 'Bearer valid') {
    return unauthorizedError()
  }
  ctx.currentUser = { id: 'u1' }
}

describe('middlewares', () => {
  it('run global, group and route middlewares in order', async () => {
    const calls: string[] = []
    const track =
      (name: string): Middleware =>
      () => {
        calls.push(name)
      }

    const { inject } = await createTestApp(
      (router) => {
        router.createGroup('/api', [track('group')]).defineRoute({
          path: '/items',
          middlewares: [track('route-1'), track('route-2')],
          handler: () => {
            calls.push('handler')
            return []
          },
        })
      },
      { middlewares: [track('global')] }
    )

    await inject({ url: '/api/items' })

    expect(calls).toEqual(['global', 'group', 'route-1', 'route-2', 'handler'])
  })

  it('run before request validation', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/members',
        middlewares: [requireUser],
        schema: (z) => ({ body: z.object({ name: z.string() }) }),
        handler: () => ({ ok: true }),
      })
    })

    const anonymous = await inject({
      method: 'post',
      url: '/members',
      body: {},
    })
    const authenticated = await inject({
      method: 'post',
      url: '/members',
      body: {},
      headers: { authorization: 'Bearer valid' },
    })

    expect(anonymous.status).toBe(401)
    expect(authenticated.status).toBe(400)
  })

  it('see raw values while handlers see parsed values', async () => {
    let seenByMiddleware: unknown

    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        path: '/list',
        middlewares: [
          (ctx) => {
            seenByMiddleware = ctx.req.query.page
          },
        ],
        schema: (z) => ({ query: z.object({ page: z.coerce.number() }) }),
        handler: ({ req }) => ({ page: req.query.page }),
      })
    })

    const res = await inject({ url: '/list?page=3' })

    expect(seenByMiddleware).toBe('3')
    expect(res.body).toEqual({ page: 3 })
  })

  it('stop the pipeline when they return an error or a response', async () => {
    const handler = vi.fn(() => ({ ok: true }))

    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        path: '/private',
        middlewares: [requireUser],
        handler,
      })
      router.defineRoute({
        path: '/legacy',
        middlewares: [() => redirect('/new', { status: 308 })],
        handler,
      })
    })

    const denied = await inject({ url: '/private' })
    const redirected = await inject({ url: '/legacy' })

    expect(denied.status).toBe(401)
    expect(redirected.status).toBe(308)
    expect(redirected.headers.location).toBe('/new')
    expect(handler).not.toHaveBeenCalled()
  })

  it('can enrich the context for handlers', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        path: '/me',
        middlewares: [requireUser],
        handler: (ctx) => ctx.currentUser,
      })
    })

    const res = await inject({
      url: '/me',
      headers: { authorization: 'Bearer valid' },
    })

    expect(res.body).toEqual({ id: 'u1' })
  })

  it('handle thrown errors like handlers do', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        path: '/http-error',
        middlewares: [
          () => {
            throw unauthorizedError('Token expired')
          },
        ],
        handler: () => null,
      })
      router.defineRoute({
        path: '/crash',
        middlewares: [
          () => {
            throw new Error('boom')
          },
        ],
        handler: () => null,
      })
    })

    const httpError = await inject({ url: '/http-error' })
    const crash = await inject({ url: '/crash' })

    expect(httpError.status).toBe(401)
    expect(httpError.body).toMatchObject({ message: 'Token expired' })
    expect(crash.status).toBe(500)
  })

  it('reject unsupported return values', async () => {
    const { inject } = await createTestApp(
      (router) => {
        router.defineRoute({
          path: '/invalid',
          // @ts-expect-error middlewares cannot return arbitrary values
          middlewares: [() => true],
          handler: () => null,
        })
      },
      { exposeErrors: true }
    )

    const res = await inject({ url: '/invalid' })

    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({
      data: { message: expect.stringContaining('A middleware must return') },
    })
  })
})

describe('defineMiddleware()', () => {
  it('returns the middleware unchanged', () => {
    const middleware = () => undefined
    expect(defineMiddleware(middleware)).toBe(middleware)
  })
})

describe('req.ip', () => {
  it('exposes the client IP address given by the adapter', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        path: '/ip',
        handler: ({ req }) => ({ ip: req.ip }),
      })
    })

    expect((await inject({ url: '/ip', ip: '203.0.113.7' })).body).toEqual({
      ip: '203.0.113.7',
    })
    expect((await inject({ url: '/ip' })).body).toEqual({})
  })
})
