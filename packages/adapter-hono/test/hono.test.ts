import { connect, type AddressInfo, type Socket } from 'node:net'
import {
  createApp,
  createRouter,
  sse,
  type AppOptions,
  type Router,
} from '@dotpress/core'
import { createMemoryLogger, type MemoryLogger } from '@dotpress/testing'
import { Hono, type Context } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  honoAdapter,
  type HonoAdapter,
  type HonoAdapterOptions,
} from '../src/index.js'
import { honoAdapter as nodeHonoAdapter } from '../src/node.js'
import { startNode } from './support.js'

const routerWith = (define: (router: Router) => void) => {
  const router = createRouter()
  define(router)
  return router
}

const closing: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(closing.splice(0).map((item) => item.close()))
})

interface Served {
  readonly adapter: HonoAdapter
  readonly logger: MemoryLogger
  fetch(path: string, init?: RequestInit): Promise<Response>
}

/** Creates an app on the in-memory adapter. */
const serve = async (
  define: (router: Router) => void,
  options: HonoAdapterOptions<Hono> = {},
  appOptions: Omit<AppOptions, 'adapter' | 'routers'> = {}
): Promise<Served> => {
  const adapter = honoAdapter(options)
  const logger = createMemoryLogger()
  const app = await createApp({
    logger,
    ...appOptions,
    adapter,
    routers: [routerWith(define)],
  })
  closing.push(app)
  return {
    adapter,
    logger,
    fetch: (path, init) =>
      adapter.fetch(new Request(new URL(path, 'http://localhost'), init)),
  }
}

const echo = (router: Router) => {
  router.defineRoute({
    method: 'post',
    path: '/echo',
    handler: ({ req }) => ({ body: req.body }),
  })
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const unhandled = (message: string) => ({
  level: 'error',
  args: [
    expect.objectContaining({ message: expect.stringContaining(message) }),
    'Unhandled error while processing request',
  ],
})

describe('honoAdapter()', () => {
  describe('native middlewares', () => {
    it('runs beforeRoutes middlewares and routes first', async () => {
      const { fetch } = await serve(
        (router) => {
          router.defineRoute({ path: '/hello', handler: () => ({ hi: 1 }) })
          router.defineRoute({ path: '/native', handler: () => 'dotpress' })
        },
        {
          beforeRoutes: (app) => {
            app.use('*', secureHeaders())
            app.get('/native', (c) => c.text('native'))
          },
        }
      )

      const res = await fetch('/hello')
      expect(await res.json()).toEqual({ hi: 1 })
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')

      expect(await (await fetch('/native')).text()).toBe('native')
    })

    it('runs afterRoutes routes before the not-found handler', async () => {
      const { fetch } = await serve(
        (router) => {
          router.defineRoute({ path: '/shared', handler: () => 'dotpress' })
        },
        {
          afterRoutes: (app) => {
            app.get('/legacy', (c) => c.text('legacy'))
            app.get('/shared', (c) => c.text('native'))
          },
        }
      )

      expect(await (await fetch('/legacy')).text()).toBe('legacy')
      expect(await (await fetch('/shared')).json()).toBe('dotpress')

      const missing = await fetch('/missing')
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({
        error: 'NOT_FOUND',
        message: 'Route not found',
      })
    })

    it('converts native client errors to the Dotpress error format', async () => {
      const { fetch } = await serve(
        (router) => {
          router.defineRoute({ path: '/secure/me', handler: () => 'me' })
          router.defineRoute({ path: '/teapot', handler: () => 'tea' })
          router.defineRoute({ path: '/invalid', handler: () => 'ok' })
          router.defineRoute({ path: '/custom', handler: () => 'custom' })
        },
        {
          beforeRoutes: (app) => {
            app.use('/secure/*', bearerAuth({ token: 'secret' }))
            app.use('/teapot', () => {
              throw new HTTPException(418)
            })
            app.use('/invalid', () => {
              throw new HTTPException(400)
            })
            app.use('/custom', () => {
              throw new HTTPException(409, {
                message: 'Already exists',
                res: new Response('ignored', {
                  status: 409,
                  headers: [
                    ['content-type', 'text/plain'],
                    ['x-reason', 'duplicate'],
                    ['set-cookie', 'a=1'],
                    ['set-cookie', 'b=2'],
                  ],
                }),
              })
            })
          },
        }
      )

      const unauthorized = await fetch('/secure/me')
      expect(unauthorized.status).toBe(401)
      expect(unauthorized.headers.get('content-type')).toBe(
        'application/json; charset=utf-8'
      )
      expect(unauthorized.headers.get('www-authenticate')).toMatch(/^Bearer /)
      expect(await unauthorized.json()).toEqual({
        status: 401,
        error: 'UNAUTHORIZED',
        message: 'Unauthorized',
      })

      const authorized = await fetch('/secure/me', {
        headers: { authorization: 'Bearer secret' },
      })
      expect(await authorized.json()).toBe('me')

      expect(await (await fetch('/teapot')).json()).toEqual({
        status: 418,
        error: 'CLIENT_ERROR',
        message: 'Client Error',
      })

      expect(await (await fetch('/invalid')).json()).toEqual({
        status: 400,
        error: 'BAD_REQUEST',
        message: 'Bad Request',
      })

      const custom = await fetch('/custom')
      expect(await custom.json()).toEqual({
        status: 409,
        error: 'CONFLICT',
        message: 'Already exists',
      })
      expect(custom.headers.get('x-reason')).toBe('duplicate')
      expect(custom.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    })

    it('reports unexpected native errors through onError', async () => {
      const onError = vi.fn()
      const { fetch, logger } = await serve(
        (router) => {
          router.defineRoute({ path: '/unavailable', handler: () => null })
          router.defineRoute({ path: '/crash', handler: () => null })
          router.defineRoute({ path: '/status', handler: () => null })
        },
        {
          beforeRoutes: (app) => {
            app.use('/unavailable', () => {
              throw new HTTPException(503, { message: 'Maintenance' })
            })
            app.use('/crash', () => {
              throw new Error('Native failure')
            })
            // Only HTTPException errors keep their status.
            app.use('/status', () => {
              throw Object.assign(new Error('Not an HTTPException'), {
                status: 400,
              })
            })
          },
        },
        { onError }
      )

      for (const path of ['/unavailable', '/crash', '/status']) {
        const res = await fetch(path)
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({
          status: 500,
          error: 'INTERNAL_ERROR',
          message: 'Internal Server Error',
        })
      }
      expect(onError).toHaveBeenCalledTimes(3)
      expect(logger.entries).toContainEqual(unhandled('Native failure'))
    })

    it('converts the errors of the Hono body limit', async () => {
      const { fetch } = await serve(echo, {
        beforeRoutes: (app) => {
          app.use('*', bodyLimit({ maxSize: 4 }))
        },
      })

      const res = await fetch('/echo', postJson({ large: true }))
      expect(res.status).toBe(413)
      expect(await res.json()).toMatchObject({ error: 'PAYLOAD_TOO_LARGE' })
    })
  })

  describe('bodies read by native middlewares', () => {
    const reading = (
      read: (c: Context) => Promise<unknown>
    ): HonoAdapterOptions<Hono> => ({
      beforeRoutes: (app) => {
        app.use('*', async (c, next) => {
          await read(c)
          await next()
        })
      },
    })

    const raw = (router: Router) => {
      router.defineRoute({
        method: 'post',
        path: '/raw',
        rawBody: true,
        handler: ({ req }) => ({
          body: req.body,
          raw: new TextDecoder().decode(req.rawBody),
        }),
      })
    }

    it('uses the bodies kept in the cache of Hono', async () => {
      const { fetch } = await serve(
        echo,
        reading((c) => c.req.json())
      )

      const res = await fetch('/echo', postJson({ a: 1 }))
      expect(await res.json()).toEqual({ body: { a: 1 } })
    })

    it('keeps the raw bytes when the body was read as bytes', async () => {
      for (const read of [
        (c: Context) => c.req.arrayBuffer(),
        (c: Context) => c.req.blob(),
      ]) {
        const { fetch } = await serve(raw, reading(read))
        const res = await fetch('/raw', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{ "a" : 1 }',
        })
        expect(await res.json()).toEqual({ body: { a: 1 }, raw: '{ "a" : 1 }' })
      }
    })

    it('cannot provide the raw body once it was read as text', async () => {
      const { fetch, logger } = await serve(
        raw,
        reading((c) => c.req.text())
      )

      const res = await fetch('/raw', postJson({ a: 1 }))
      expect(res.status).toBe(500)
      expect(logger.entries).toContainEqual(unhandled('raw request body'))
    })

    it('uses form data parsed by native middlewares', async () => {
      for (const read of [
        (c: Context) => c.req.parseBody(),
        (c: Context) => c.req.formData(),
      ]) {
        await expectUpload(read)
      }
    })

    const expectUpload = async (read: (c: Context) => Promise<unknown>) => {
      const { fetch } = await serve((router) => {
        router.defineRoute({
          method: 'post',
          path: '/upload',
          handler: ({ req }) => ({
            body: req.body,
            file: (req.files.file as File).name,
          }),
        })
      }, reading(read))

      const form = new FormData()
      form.append('title', 'Report')
      form.append('file', new File(['content'], 'report.txt'))
      const res = await fetch('/upload', { method: 'POST', body: form })

      expect(await res.json()).toEqual({
        body: { title: 'Report' },
        file: 'report.txt',
      })
    }

    it('applies the body limit to cached bodies', async () => {
      const { fetch } = await serve(
        (router) => {
          router.defineRoute({
            method: 'post',
            path: '/small',
            bodyLimit: 4,
            handler: () => null,
          })
        },
        reading((c) => c.req.text())
      )

      const res = await fetch('/small', postJson({ large: true }))
      expect(res.status).toBe(413)
    })

    it('reports bodies read outside the cache of Hono', async () => {
      const { fetch, logger } = await serve(
        echo,
        reading((c) => c.req.raw.text())
      )

      const res = await fetch('/echo', postJson({ a: 1 }))
      expect(res.status).toBe(500)
      expect(logger.entries).toContainEqual(
        unhandled('outside the cache of Hono')
      )
    })
  })

  describe('requests', () => {
    it('exposes the Hono context as ctx.raw', async () => {
      const { fetch } = await serve((router) => {
        router.defineRoute({
          path: '/raw',
          handler: ({ raw }) => ({ path: (raw as Context).req.path }),
        })
      })

      expect(await (await fetch('/raw')).json()).toEqual({ path: '/raw' })
    })

    it('takes the IP address from getIp, or from the runtime', async () => {
      const ip = (router: Router) => {
        router.defineRoute({
          path: '/ip',
          handler: ({ req }) => req.ip ?? null,
        })
      }

      const getIp = vi.fn((c: Context) => c.req.header('x-client-ip'))
      const custom = await serve(ip, { getIp })
      const res = await custom.fetch('/ip', {
        headers: { 'x-client-ip': '203.0.113.7' },
      })
      expect(await res.json()).toBe('203.0.113.7')

      // No address without a runtime giving one.
      const memory = await serve(ip)
      expect(await (await memory.fetch('/ip')).json()).toBeNull()

      // Proxy headers are ignored by default.
      const target = await startNode(nodeHonoAdapter(), {
        logger: createMemoryLogger(),
        routers: [routerWith(ip)],
      })
      closing.push(target)
      const proxied = await target.fetch('/ip', {
        headers: { 'x-forwarded-for': '203.0.113.7' },
      })
      expect(await proxied.json()).toMatch(/^((::ffff:)?127\.0\.0\.1|::1)$/)
    })

    it('applies the bodyLimit option', async () => {
      const { fetch } = await serve(echo, { bodyLimit: 8 })

      expect((await fetch('/echo', postJson('1234'))).status).toBe(200)
      expect((await fetch('/echo', postJson('12345678'))).status).toBe(413)
    })

    it('rejects invalid body limits', () => {
      expect(() => honoAdapter({ bodyLimit: -1 })).toThrow('Invalid bodyLimit')
      expect(() => honoAdapter({ bodyLimit: 1.5 })).toThrow('Invalid bodyLimit')
    })

    it('mounts the routes on the given application', async () => {
      const app = new Hono()
      app.get('/before', (c) => c.text('before'))
      const adapter = honoAdapter({ app })
      expect(adapter.native()).toBe(app)

      await createApp({
        adapter,
        logger: createMemoryLogger(),
        routers: [routerWith(echo)],
      })

      const before = await app.request('/before')
      expect(await before.text()).toBe('before')
      const res = await app.request('/echo', postJson({ a: 1 }))
      expect(await res.json()).toEqual({ body: { a: 1 } })
    })
  })

  describe('lifecycle', () => {
    const events = (released: () => void) =>
      routerWith((router) => {
        router.defineRoute({
          path: '/events',
          handler: () =>
            sse(async function* ({ signal }) {
              try {
                yield 'ready'
                await new Promise((resolve) =>
                  signal.addEventListener('abort', resolve)
                )
              } finally {
                released()
              }
            }),
        })
      })

    it('closes open Server-Sent Events streams on close()', async () => {
      const released = vi.fn()
      const target = await startNode(nodeHonoAdapter(), {
        logger: createMemoryLogger(),
        routers: [events(released)],
      })

      const res = await target.fetch('/events')
      const reader = res.body!.getReader()
      await reader.read()

      await target.close()

      expect(released).toHaveBeenCalledOnce()
      expect(await reader.read()).toMatchObject({ done: true })
    })

    it('keeps the connections alive between requests', async () => {
      const adapter = nodeHonoAdapter()
      const target = await startNode(adapter, {
        logger: createMemoryLogger(),
        routers: [
          routerWith((router) => {
            router.defineRoute({ path: '/hello', handler: () => ({ hi: 1 }) })
          }),
        ],
      })
      let closed = 0
      adapter.server()!.on('connection', (socket: Socket) => {
        socket.once('close', () => {
          closed += 1
        })
      })

      for (let index = 0; index < 3; index += 1) {
        expect(await (await target.fetch('/hello')).json()).toEqual({ hi: 1 })
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(closed).toBe(0)
      await target.close()
    })

    // Before Node.js 26, server.close() waits for a connection that has not
    // sent a request (a browser preconnect…) until headersTimeout.
    it('closes the connections that sent nothing, and waits for pending requests', async () => {
      let started!: () => void
      const handlerStarted = new Promise<void>((resolve) => (started = resolve))
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      const adapter = nodeHonoAdapter()
      const target = await startNode(adapter, {
        logger: createMemoryLogger(),
        routers: [
          routerWith((router) => {
            router.defineRoute({
              path: '/slow',
              handler: async () => {
                started()
                await released
                return { done: true }
              },
            })
          }),
        ],
      })
      const server = adapter.server()!
      const { port } = server.address() as AddressInfo

      const pending = target.fetch('/slow')
      await handlerStarted
      const accepted = new Promise((resolve) =>
        server.once('connection', resolve)
      )
      const silent = connect(port, '127.0.0.1').on('error', () => {})
      const silentClosed = new Promise((resolve) =>
        silent.once('close', resolve)
      )
      await accepted

      let closed = false
      const closing = target.close().then(() => {
        closed = true
      })
      await silentClosed
      expect(closed).toBe(false)

      release()
      expect(await (await pending).json()).toEqual({ done: true })
      // Without waiting for keepAliveTimeout.
      const served = Date.now()
      await closing
      expect(Date.now() - served).toBeLessThan(1000)
    })

    it('closes the streams served without listening on close()', async () => {
      for (const adapter of [honoAdapter(), nodeHonoAdapter()]) {
        const released = vi.fn()
        const app = await createApp({
          adapter,
          logger: createMemoryLogger(),
          routers: [events(released)],
        })

        const res = await adapter.fetch(new Request('http://localhost/events'))
        const reader = res.body!.getReader()
        await reader.read()

        await app.close()

        expect(released).toHaveBeenCalledOnce()
        expect(await reader.read()).toMatchObject({ done: true })
      }
    })

    it('exposes the native application and server', async () => {
      const adapter = nodeHonoAdapter()
      expect(adapter.server()).toBeUndefined()
      expect(adapter.native()).toBeInstanceOf(Hono)

      const target = await startNode(adapter, {
        logger: createMemoryLogger(),
        routers: [createRouter()],
      })
      closing.push(target)
      expect(adapter.server()?.listening).toBe(true)
      // The listen() error handler is removed once listening.
      expect(adapter.server()?.listenerCount('error')).toBe(0)

      await target.close()
      expect(adapter.server()).toBeUndefined()
    })

    it('refuses to listen twice or to be mounted twice', async () => {
      const adapter = nodeHonoAdapter()
      const target = await startNode(adapter, {
        logger: createMemoryLogger(),
        routers: [createRouter()],
      })
      closing.push(target)

      await expect(adapter.listen(0)).rejects.toThrow('already listening')
      await expect(
        createApp({ adapter, routers: [createRouter()] })
      ).rejects.toThrow('already mounted')
    })

    it('rejects listen() when the port is not available', async () => {
      const first = nodeHonoAdapter()
      closing.push(
        await startNode(first, {
          logger: createMemoryLogger(),
          routers: [createRouter()],
        })
      )
      const { port } = first.server()!.address() as AddressInfo

      const second = nodeHonoAdapter()
      const app = await createApp({
        adapter: second,
        logger: createMemoryLogger(),
        routers: [createRouter()],
      })

      await expect(app.listen(port, '127.0.0.1')).rejects.toThrow('EADDRINUSE')
      expect(second.server()).toBeUndefined()
      await app.close()
    })
  })
})
