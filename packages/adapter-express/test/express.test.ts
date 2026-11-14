import { createServer } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import {
  createApp,
  createRouter,
  sse,
  stream,
  type Router,
} from '@dotpress/core'
import { createMemoryLogger } from '@dotpress/testing'
import express from 'express'
import express4 from 'express-4'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expressAdapter, startApp } from './support.js'

const routerWith = (define: (router: Router) => void) => {
  const router = createRouter()
  define(router)
  return router
}

const targets: { close(): Promise<void> }[] = []

const start = async (...args: Parameters<typeof startApp>) => {
  const target = await startApp(...args)
  targets.push(target)
  return target
}

afterEach(async () => {
  await Promise.all(targets.splice(0).map((target) => target.close()))
})

describe('expressAdapter()', () => {
  describe('native middlewares', () => {
    it('runs beforeRoutes middlewares before the Dotpress routes', async () => {
      const { fetch } = await start(
        expressAdapter({
          beforeRoutes: (app) => {
            app.use((_req, res, next) => {
              res.setHeader('x-frame-options', 'DENY')
              next()
            })
            app.get('/maintenance', (_req, res) => {
              res.status(503).send('Down')
            })
          },
        }),
        {
          logger: createMemoryLogger(),
          routers: [
            routerWith((router) => {
              router.defineRoute({ path: '/data', handler: () => ({ a: 1 }) })
              router.defineRoute({
                path: '/maintenance',
                handler: () => 'unreachable',
              })
            }),
          ],
        }
      )

      const data = await fetch('/data')
      expect(data.headers.get('x-frame-options')).toBe('DENY')
      expect(await data.json()).toEqual({ a: 1 })

      const maintenance = await fetch('/maintenance')
      expect(maintenance.status).toBe(503)
      expect(await maintenance.text()).toBe('Down')
    })

    it('runs afterRoutes routes before the not-found handler', async () => {
      const { fetch } = await start(
        expressAdapter({
          afterRoutes: (app) => {
            app.get('/native', (_req, res) => {
              res.json({ native: true })
            })
          },
        }),
        {
          logger: createMemoryLogger(),
          routers: [
            routerWith((router) => {
              router.defineRoute({ path: '/dotpress', handler: () => 'ok' })
            }),
          ],
        }
      )

      expect(await (await fetch('/dotpress')).json()).toBe('ok')
      expect(await (await fetch('/native')).json()).toEqual({ native: true })
      expect(await (await fetch('/missing')).json()).toMatchObject({
        error: 'NOT_FOUND',
      })
    })

    it('converts native client errors to the Dotpress error format', async () => {
      const { fetch } = await start(
        expressAdapter({
          beforeRoutes: (app) => {
            app.use('/forbidden', (_req, _res, next) => {
              next(
                Object.assign(new Error('IP address not allowed'), {
                  status: 403,
                  expose: true,
                })
              )
            })
            app.use('/hidden', (_req, _res, next) => {
              next(Object.assign(new Error('Internal detail'), { status: 400 }))
            })
          },
        }),
        { logger: createMemoryLogger(), routers: [createRouter()] }
      )

      const forbidden = await fetch('/forbidden')
      expect(forbidden.status).toBe(403)
      expect(forbidden.headers.get('x-request-id')).toBeTruthy()
      expect(await forbidden.json()).toEqual({
        status: 403,
        error: 'FORBIDDEN',
        message: 'IP address not allowed',
      })

      expect(await (await fetch('/hidden')).json()).toEqual({
        status: 400,
        error: 'BAD_REQUEST',
        message: 'Bad Request',
      })
    })

    it('reports unexpected native errors through onError', async () => {
      const onError = vi.fn()
      const failure = new Error('Session store unavailable')

      const { fetch } = await start(
        expressAdapter({
          beforeRoutes: (app) => {
            app.use((_req, _res, next) => next(failure))
          },
        }),
        { logger: createMemoryLogger(), routers: [createRouter()], onError }
      )

      const res = await fetch('/anything')
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ error: 'INTERNAL_ERROR' })
      expect(onError).toHaveBeenCalledWith(failure, undefined)
    })

    it('uses bodies parsed by native middlewares', async () => {
      const { fetch } = await start(
        expressAdapter({
          beforeRoutes: (app) => {
            app.use(express.json())
          },
        }),
        {
          logger: createMemoryLogger(),
          routers: [
            routerWith((router) => {
              router.defineRoute({
                method: 'post',
                path: '/echo',
                handler: ({ req }) => ({ body: req.body }),
              })
            }),
          ],
        }
      )

      const parsed = await fetch('/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      })
      expect(await parsed.json()).toEqual({ body: { a: 1 } })

      // Content types ignored by express.json() are read by the adapter.
      const text = await fetch('/echo', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      })
      expect(await text.json()).toEqual({ body: 'hello' })

      const malformed = await fetch('/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toMatchObject({ error: 'MALFORMED_BODY' })
    })

    it('cannot provide the raw body once a native middleware read it', async () => {
      const logger = createMemoryLogger()
      const { fetch } = await start(
        expressAdapter({
          beforeRoutes: (app) => {
            app.use(express.json())
          },
        }),
        {
          logger,
          routers: [
            routerWith((router) => {
              router.defineRoute({
                method: 'post',
                path: '/webhooks',
                rawBody: true,
                handler: () => ({ unreachable: true }),
              })
            }),
          ],
        }
      )

      const res = await fetch('/webhooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      })

      expect(res.status).toBe(500)
      expect(logger.entries).toContainEqual({
        level: 'error',
        args: [
          expect.objectContaining({
            message: expect.stringContaining('raw request body'),
          }),
          'Unhandled error while processing request',
        ],
      })
    })

    it('calls res.flush() after each chunk for compression middlewares', async () => {
      const flush = vi.fn()

      const { fetch } = await start(
        expressAdapter({
          beforeRoutes: (app) => {
            app.use((_req, res, next) => {
              Object.assign(res, { flush })
              next()
            })
          },
        }),
        {
          logger: createMemoryLogger(),
          routers: [
            routerWith((router) => {
              router.defineRoute({
                path: '/stream',
                handler: () => stream(['a', 'b', 'c']),
              })
            }),
          ],
        }
      )

      expect(await (await fetch('/stream')).text()).toBe('abc')
      expect(flush).toHaveBeenCalledTimes(3)
    })
  })

  describe('requests', () => {
    it('exposes the Express request as ctx.raw', async () => {
      const { fetch } = await start(expressAdapter(), {
        logger: createMemoryLogger(),
        routers: [
          routerWith((router) => {
            router.defineRoute({
              path: '/raw',
              handler: ({ raw }) => ({
                originalUrl: (raw as express.Request).originalUrl,
              }),
            })
          }),
        ],
      })

      expect(await (await fetch('/raw?x=1')).json()).toEqual({
        originalUrl: '/raw?x=1',
      })
    })

    it('only trusts proxy headers for req.ip with the trust proxy setting', async () => {
      const ipRouter = () =>
        routerWith((router) => {
          router.defineRoute({
            path: '/ip',
            handler: ({ req }) => ({ ip: req.ip }),
          })
        })
      const forwarded = { headers: { 'x-forwarded-for': '203.0.113.9' } }

      const direct = await start(expressAdapter(), {
        logger: createMemoryLogger(),
        routers: [ipRouter()],
      })
      expect(await (await direct.fetch('/ip', forwarded)).json()).not.toEqual({
        ip: '203.0.113.9',
      })

      const proxied = await start(
        expressAdapter({
          beforeRoutes: (app) => {
            app.set('trust proxy', 'loopback')
          },
        }),
        { logger: createMemoryLogger(), routers: [ipRouter()] }
      )
      expect(await (await proxied.fetch('/ip', forwarded)).json()).toEqual({
        ip: '203.0.113.9',
      })
    })

    it('applies the bodyLimit option', async () => {
      const { fetch } = await start(expressAdapter({ bodyLimit: 10 }), {
        logger: createMemoryLogger(),
        routers: [
          routerWith((router) => {
            router.defineRoute({
              method: 'post',
              path: '/small',
              handler: ({ req }) => ({ body: req.body }),
            })
          }),
        ],
      })

      const small = await fetch('/small', {
        method: 'POST',
        body: '1234567890',
      })
      expect(small.status).toBe(200)

      const large = await fetch('/small', {
        method: 'POST',
        body: '12345678901',
      })
      expect(large.status).toBe(413)
    })

    it('rejects invalid body limits', () => {
      expect(() => expressAdapter({ bodyLimit: -1 })).toThrow(RangeError)
      expect(() => expressAdapter({ bodyLimit: 1.5 })).toThrow(RangeError)
    })

    it('rejects unknown options', () => {
      expect(() => expressAdapter({ bodylimit: 1 } as never)).toThrow(
        new TypeError('expressAdapter(): unknown option "bodylimit".')
      )
    })

    it('works when mounted in a parent Express application', async () => {
      const adapter = expressAdapter()
      const app = await createApp({
        adapter,
        logger: createMemoryLogger(),
        routers: [
          routerWith((router) => {
            router.defineRoute({
              path: '/users/:id',
              handler: ({ req }) => ({ id: req.params.id, path: req.path }),
            })
          }),
        ],
      })

      const parent = express4()
      parent.use('/api', app.native())
      const server = createServer(parent)
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      )
      targets.push({
        close: () => new Promise((resolve) => server.close(() => resolve())),
      })

      const { port } = server.address() as AddressInfo
      const res = await fetch(`http://127.0.0.1:${port}/api/users/42`)

      expect(await res.json()).toEqual({ id: '42', path: '/users/42' })
    })
  })

  describe('lifecycle', () => {
    it('closes open Server-Sent Events streams on close()', async () => {
      const released = vi.fn()
      const target = await startApp(expressAdapter(), {
        logger: createMemoryLogger(),
        routers: [
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
          }),
        ],
      })

      const res = await target.fetch('/events')
      const reader = res.body!.getReader()
      await reader.read()

      await target.close()

      expect(released).toHaveBeenCalledOnce()
      expect(await reader.read()).toMatchObject({ done: true })
    })

    it('closes open streams on close(), with a server of the app', async () => {
      const released = vi.fn()
      const app = await createApp({
        adapter: expressAdapter(),
        logger: createMemoryLogger(),
        routers: [
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
          }),
        ],
      })
      // Like an HTTPS server created by the app.
      const server = createServer(app.native())
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      )
      const { port } = server.address() as AddressInfo

      const res = await fetch(`http://127.0.0.1:${port}/events`)
      const reader = res.body!.getReader()
      await reader.read()

      await app.close()

      expect(released).toHaveBeenCalledOnce()
      expect(await reader.read()).toMatchObject({ done: true })
      await new Promise((resolve) => server.close(resolve))
    })

    it('keeps the connections alive between requests', async () => {
      const adapter = expressAdapter()
      const target = await startApp(adapter, {
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
      const adapter = expressAdapter()
      const target = await startApp(adapter, {
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

    it('exposes the native application and server', async () => {
      const adapter = expressAdapter()
      expect(adapter.server()).toBeUndefined()
      expect(adapter.native().disabled('x-powered-by')).toBe(true)

      const { adapter: started } = await start(adapter, {
        logger: createMemoryLogger(),
        routers: [createRouter()],
      })
      expect(started.server()?.listening).toBe(true)
    })

    it('refuses to listen twice or to be mounted twice', async () => {
      const adapter = expressAdapter()
      const target = await start(adapter, {
        logger: createMemoryLogger(),
        routers: [createRouter()],
      })

      await expect(adapter.listen(0)).rejects.toThrow('already listening')
      await expect(
        createApp({ adapter, routers: [createRouter()] })
      ).rejects.toThrow('already mounted')
      await target.close()
    })

    it('rejects listen() when the port is not available', async () => {
      const first = await start(expressAdapter(), {
        logger: createMemoryLogger(),
        routers: [createRouter()],
      })
      const { port } = first.adapter.server()!.address() as AddressInfo

      const second = await createApp({
        adapter: expressAdapter(),
        logger: createMemoryLogger(),
        routers: [createRouter()],
      })

      await expect(second.listen(port, '127.0.0.1')).rejects.toThrow(
        'EADDRINUSE'
      )
    })
  })
})
