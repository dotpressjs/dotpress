import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { connect, type AddressInfo } from 'node:net'
import {
  createApp,
  createRouter,
  sse,
  type AppOptions,
  type Router,
} from '@dotpress/core'
import { createMemoryLogger } from '@dotpress/testing'
import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fastifyAdapter, startApp } from './support.js'

const routerWith = (define: (router: Router) => void) => {
  const router = createRouter()
  define(router)
  return router
}

const targets: { close(): Promise<void> }[] = []

const start = async (
  adapter: ReturnType<typeof fastifyAdapter>,
  define: (router: Router) => void,
  options: Omit<AppOptions, 'adapter' | 'routers'> = {}
) => {
  const logger = createMemoryLogger()
  const target = await startApp(adapter, {
    logger,
    ...options,
    routers: [routerWith(define)],
  })
  targets.push(target)
  return { ...target, logger }
}

afterEach(async () => {
  await Promise.all(targets.splice(0).map((target) => target.close()))
})

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

describe('fastifyAdapter()', () => {
  describe('native hooks, plugins and routes', () => {
    it('applies beforeRoutes hooks to the Dotpress routes, not afterRoutes hooks', async () => {
      const { fetch } = await start(
        fastifyAdapter({
          beforeRoutes: (app) => {
            app.addHook('onRequest', async (_request, reply) => {
              reply.header('x-before', '1')
            })
          },
          afterRoutes: (app) => {
            app.addHook('onRequest', async (_request, reply) => {
              reply.header('x-after', '1')
            })
            app.get('/native', async () => ({ native: true }))
          },
        }),
        (router) => {
          router.defineRoute({ path: '/hello', handler: () => ({ hi: 1 }) })
          router.defineRoute({
            path: '/events',
            handler: () => sse(['ready']),
          })
        }
      )

      const hello = await fetch('/hello')
      expect(await hello.json()).toEqual({ hi: 1 })
      expect(hello.headers.get('x-before')).toBe('1')
      expect(hello.headers.get('x-after')).toBeNull()

      // Also on streamed responses.
      const events = await fetch('/events')
      expect(events.headers.get('x-before')).toBe('1')
      await events.text()

      const native = await fetch('/native')
      expect(await native.json()).toEqual({ native: true })
      expect(native.headers.get('x-after')).toBe('1')
    })

    it('keeps the Fastify body parsers for native routes', async () => {
      const { fetch } = await start(
        fastifyAdapter({
          afterRoutes: (app) => {
            app.post('/native', async (request) => ({
              parsed: request.body,
            }))
          },
        }),
        (router) => {
          router.defineRoute({
            method: 'post',
            path: '/dotpress',
            rawBody: true,
            handler: ({ req }) => ({
              body: req.body,
              raw: new TextDecoder().decode(req.rawBody),
            }),
          })
        }
      )

      expect(await (await fetch('/native', postJson({ a: 1 }))).json()).toEqual(
        { parsed: { a: 1 } }
      )
      expect(
        await (await fetch('/dotpress', postJson({ a: 1 }))).json()
      ).toEqual({ body: { a: 1 }, raw: '{"a":1}' })
    })

    it('reads the payload transformed by preParsing hooks', async () => {
      const { fetch } = await start(
        fastifyAdapter({
          beforeRoutes: (app) => {
            app.addHook('preParsing', async () => Readable.from(['replaced']))
          },
        }),
        (router) => {
          router.defineRoute({
            method: 'post',
            path: '/echo',
            handler: ({ req }) => ({ body: req.body }),
          })
        }
      )

      const res = await fetch('/echo', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'original',
      })
      expect(await res.json()).toEqual({ body: 'replaced' })
    })

    it('rejects native routes that conflict with Dotpress routes', async () => {
      const adapter = fastifyAdapter({
        beforeRoutes: (app) => {
          app.get('/hello', async () => 'native')
        },
      })

      await expect(
        createApp({
          adapter,
          logger: createMemoryLogger(),
          routers: [
            routerWith((router) => {
              router.defineRoute({ path: '/hello', handler: () => 'dotpress' })
            }),
          ],
        })
      ).rejects.toThrow("Method 'GET' already declared for route '/hello'")
    })

    it('gives the route path to Fastify (logs, metrics)', async () => {
      const urls: (string | undefined)[] = []
      const { fetch } = await start(
        fastifyAdapter({
          beforeRoutes: (app) => {
            app.addHook('onResponse', async (request: FastifyRequest) => {
              urls.push(request.routeOptions.url)
            })
          },
        }),
        (router) => {
          router.defineRoute({
            path: '/users/:id',
            handler: ({ req }) => req.params,
          })
        }
      )

      await (await fetch('/users/42')).json()
      await (await fetch('/users/42/')).json()
      expect(urls).toEqual(['/users/:id', '/users/:id/'])
    })

    it('uses explicit HEAD routes', async () => {
      const { fetch } = await start(fastifyAdapter(), (router) => {
        router.defineRoute({ path: '/file', handler: () => 'content' })
        router.defineRoute({
          method: 'head',
          path: '/file',
          handler: ({ res }) => {
            res.setHeader('x-head', 'explicit')
            return null
          },
        })
      })

      const res = await fetch('/file', { method: 'HEAD' })
      expect(res.headers.get('x-head')).toBe('explicit')
      expect(await (await fetch('/file')).json()).toBe('content')
    })
  })

  describe('errors', () => {
    it('converts native client errors to the Dotpress error format', async () => {
      const { fetch } = await start(
        fastifyAdapter({
          beforeRoutes: (app) => {
            app.addHook('onRequest', async (request, reply) => {
              if (request.url === '/limited') {
                reply.header('retry-after', '60')
                throw Object.assign(new Error('Rate limit exceeded'), {
                  statusCode: 429,
                })
              }
              if (request.url === '/teapot') {
                throw Object.assign(new Error(''), { statusCode: 418 })
              }
              if (request.url === '/invalid') {
                throw Object.assign(new Error('Invalid header'), {
                  statusCode: 400,
                })
              }
            })
          },
        }),
        (router) => {
          router.defineRoute({ path: '/limited', handler: () => null })
          router.defineRoute({ path: '/teapot', handler: () => null })
          router.defineRoute({ path: '/invalid', handler: () => null })
        }
      )

      const limited = await fetch('/limited')
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBe('60')
      expect(limited.headers.get('content-type')).toBe(
        'application/json; charset=utf-8'
      )
      expect(await limited.json()).toEqual({
        status: 429,
        error: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded',
      })

      expect(await (await fetch('/invalid')).json()).toEqual({
        status: 400,
        error: 'BAD_REQUEST',
        message: 'Invalid header',
      })

      expect(await (await fetch('/teapot')).json()).toEqual({
        status: 418,
        error: 'CLIENT_ERROR',
        message: 'Bad Request',
      })
    })

    it('rejects invalid content types like Fastify', async () => {
      const { fetch } = await start(fastifyAdapter(), (router) => {
        router.defineRoute({
          method: 'post',
          path: '/echo',
          handler: ({ req }) => ({ body: req.body }),
        })
      })

      const res = await fetch('/echo', {
        method: 'POST',
        headers: { 'content-type': 'not a type' },
        body: 'x',
      })
      expect(res.status).toBe(415)
      expect(await res.json()).toMatchObject({
        error: 'UNSUPPORTED_MEDIA_TYPE',
      })
    })

    it('reports unexpected native errors through onError', async () => {
      const onError = vi.fn()
      const { fetch, logger } = await start(
        fastifyAdapter({
          beforeRoutes: (app) => {
            app.addHook('onRequest', async (request) => {
              if (request.url === '/unavailable') {
                throw Object.assign(new Error('Maintenance'), {
                  statusCode: 503,
                })
              }
              if (request.url === '/crash') throw new Error('Native failure')
            })
          },
        }),
        (router) => {
          router.defineRoute({ path: '/unavailable', handler: () => null })
          router.defineRoute({ path: '/crash', handler: () => null })
        },
        { onError }
      )

      for (const path of ['/unavailable', '/crash']) {
        const res = await fetch(path)
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({
          status: 500,
          error: 'INTERNAL_ERROR',
          message: 'Internal Server Error',
        })
      }
      expect(onError).toHaveBeenCalledTimes(2)
      expect(logger.entries).toContainEqual(unhandled('Native failure'))
    })

    it('answers native routes and unknown paths with the Dotpress format', async () => {
      const { fetch } = await start(
        fastifyAdapter({
          afterRoutes: (app) => {
            app.get('/native-crash', async () => {
              throw Object.assign(new Error('Gone'), { statusCode: 410 })
            })
          },
        }),
        () => {}
      )

      expect(await (await fetch('/native-crash')).json()).toEqual({
        status: 410,
        error: 'CLIENT_ERROR',
        message: 'Gone',
      })
      expect(await (await fetch('/missing')).json()).toMatchObject({
        status: 404,
        error: 'NOT_FOUND',
      })
    })
  })

  describe('requests', () => {
    it('exposes the Fastify request as ctx.raw', async () => {
      const { fetch } = await start(fastifyAdapter(), (router) => {
        router.defineRoute({
          path: '/raw/:id',
          handler: ({ raw }) => ({
            url: (raw as FastifyRequest).routeOptions.url,
          }),
        })
      })

      expect(await (await fetch('/raw/1')).json()).toEqual({
        url: '/raw/:id',
      })
    })

    it('only trusts proxy headers for req.ip with the trustProxy option', async () => {
      const ip = (router: Router) => {
        router.defineRoute({ path: '/ip', handler: ({ req }) => req.ip })
      }
      const forwarded = { headers: { 'x-forwarded-for': '203.0.113.7' } }

      const direct = await start(fastifyAdapter(), ip)
      expect(await (await direct.fetch('/ip', forwarded)).json()).toMatch(
        /^((::ffff:)?127\.0\.0\.1|::1)$/
      )

      const proxied = await start(
        fastifyAdapter({ app: Fastify({ trustProxy: true }) }),
        ip
      )
      expect(await (await proxied.fetch('/ip', forwarded)).json()).toBe(
        '203.0.113.7'
      )
    })

    it('ignores clients that go away while sending the body', async () => {
      const handler = vi.fn(() => null)
      let incoming: IncomingMessage | undefined
      const { adapter, logger, fetch } = await start(
        fastifyAdapter({
          beforeRoutes: (app) => {
            app.addHook('onRequest', async (request) => {
              if (request.url === '/upload') incoming = request.raw
            })
          },
        }),
        (router) => {
          router.defineRoute({ method: 'post', path: '/upload', handler })
        }
      )
      const { port } = adapter.server()!.address() as AddressInfo

      await new Promise<void>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            'POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\npartial'
          )
          setTimeout(() => socket.destroy(), 20)
        })
        socket.on('close', () => resolve())
      })
      // The server is still available.
      expect((await fetch('/missing')).status).toBe(404)

      expect(handler).not.toHaveBeenCalled()
      expect(logger.entries).toEqual([])
      // The body reading ended: no listener left.
      await vi.waitFor(() => {
        expect(incoming?.listenerCount('data')).toBe(0)
      })
    })

    it('applies the bodyLimit option', async () => {
      const { fetch } = await start(
        fastifyAdapter({ bodyLimit: 8 }),
        (router) => {
          router.defineRoute({
            method: 'post',
            path: '/echo',
            handler: ({ req }) => ({ body: req.body }),
          })
        }
      )

      expect((await fetch('/echo', postJson('1234'))).status).toBe(200)
      expect((await fetch('/echo', postJson('12345678'))).status).toBe(413)
    })

    it('rejects invalid body limits', () => {
      expect(() => fastifyAdapter({ bodyLimit: -1 })).toThrow(
        'Invalid bodyLimit'
      )
      expect(() => fastifyAdapter({ bodyLimit: 1.5 })).toThrow(
        'Invalid bodyLimit'
      )
    })
  })

  describe('lifecycle', () => {
    it('closes open Server-Sent Events streams on close()', async () => {
      const released = vi.fn()
      const target = await startApp(fastifyAdapter(), {
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

    it('answers HEAD requests without reading streamed bodies', async () => {
      const started = vi.fn()
      const { fetch } = await start(fastifyAdapter(), (router) => {
        router.defineRoute({
          path: '/events',
          handler: () =>
            sse(async function* ({ signal }) {
              started()
              yield 'ready'
              await new Promise((resolve) =>
                signal.addEventListener('abort', resolve)
              )
            }),
        })
      })

      const res = await fetch('/events', { method: 'HEAD' })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe(
        'text/event-stream; charset=utf-8'
      )
      expect(await res.text()).toBe('')
      // The stream is cancelled before it starts.
      expect(started).not.toHaveBeenCalled()
    })

    it('closes the Fastify instance, with or without server', async () => {
      const closed = vi.fn()
      const adapter = fastifyAdapter({
        beforeRoutes: (app) => {
          app.addHook('onClose', async () => closed())
        },
      })
      const app = await createApp({
        adapter,
        logger: createMemoryLogger(),
        routers: [createRouter()],
      })

      // Without listening: inject() or AWS Lambda.
      const res = await adapter.native().inject('/missing')
      expect(res.statusCode).toBe(404)

      await app.close()
      expect(closed).toHaveBeenCalledOnce()
    })

    it('exposes the native instance and server', async () => {
      const adapter = fastifyAdapter()
      expect(adapter.server()).toBeUndefined()
      expect(typeof adapter.native().inject).toBe('function')

      const target = await start(adapter, () => {})
      expect(adapter.server()?.listening).toBe(true)

      await target.close()
      expect(adapter.server()).toBeUndefined()
    })

    it('listens on every interface without host', async () => {
      const adapter = fastifyAdapter()
      const app = await createApp({
        adapter,
        logger: createMemoryLogger(),
        routers: [createRouter()],
      })
      targets.push(app)

      await app.listen(0)
      const { address } = adapter.server()!.address() as AddressInfo
      expect(['::', '0.0.0.0']).toContain(address)
    })

    it('refuses to listen twice or to be mounted twice', async () => {
      const adapter = fastifyAdapter()
      await start(adapter, () => {})

      await expect(adapter.listen(0)).rejects.toThrow('already listening')
      await expect(
        createApp({ adapter, routers: [createRouter()] })
      ).rejects.toThrow('already mounted')
    })

    it('rejects listen() when the port is not available', async () => {
      const first = await start(fastifyAdapter(), () => {})
      const { port } = first.adapter.server()!.address() as AddressInfo

      const second = fastifyAdapter()
      const app = await createApp({
        adapter: second,
        logger: createMemoryLogger(),
        routers: [createRouter()],
      })
      targets.push(app)

      await expect(app.listen(port, '127.0.0.1')).rejects.toThrow('EADDRINUSE')
      expect(second.server()).toBeUndefined()
    })
  })
})
