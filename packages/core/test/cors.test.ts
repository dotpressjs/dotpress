import { describe, expect, it } from 'vitest'
import {
  definePlugin,
  sse,
  unauthorizedError,
  type CorsOptions,
  type ResponseEvent,
} from '../src/index.js'
import { createTestApp, silentLogger } from './support/memory-adapter.js'

const APP = 'https://app.example.com'
const EVIL = 'https://evil.example.org'

const preflight = (
  url: string,
  origin = APP,
  headers: Record<string, string> = {}
) => ({
  method: 'OPTIONS',
  url,
  headers: {
    origin,
    'access-control-request-method': 'POST',
    ...headers,
  },
})

const createCorsApp = (
  cors: CorsOptions,
  options: Parameters<typeof createTestApp>[1] = {}
) =>
  createTestApp(
    (router) => {
      router.defineRoute({ path: '/users', handler: () => [] })
      router.defineRoute({
        method: 'post',
        path: '/users',
        handler: () => ({ created: true }),
      })
      router.defineRoute({
        path: '/private',
        middlewares: [() => unauthorizedError()],
        handler: () => ({ secret: true }),
      })
      router.defineRoute({
        path: '/boom',
        handler: () => {
          throw new Error('Unexpected')
        },
      })
      router.defineRoute({
        path: '/events',
        handler: () => sse(['hello']),
      })
      router.defineRoute({
        method: 'options',
        path: '/custom',
        handler: () => ({ custom: true }),
      })
    },
    { ...options, cors }
  )

const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
]

const corsHeadersOf = (headers: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => CORS_HEADERS.includes(name))
  )

describe('cors option', () => {
  it('is disabled by default', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({ path: '/users', handler: () => [] })
    })

    const res = await inject({ url: '/users', headers: { origin: APP } })
    expect(corsHeadersOf(res.headers)).toEqual({})
    expect(res.headers.vary).toBeUndefined()

    const options = await inject(preflight('/users'))
    expect(options.status).toBe(405)
    expect(corsHeadersOf(options.headers)).toEqual({})
  })

  describe('preflight requests', () => {
    it('are answered with the methods of the path', async () => {
      const { inject } = await createCorsApp({ origin: [APP] })

      const res = await inject(
        preflight('/users', APP, {
          'access-control-request-headers': 'content-type, authorization',
        })
      )

      expect(res.status).toBe(204)
      expect(res.response.body).toBeNull()
      expect(res.text).toBeUndefined()
      expect(res.headers).toMatchObject({
        'access-control-allow-origin': APP,
        'access-control-allow-methods': 'GET, HEAD, POST',
        'access-control-allow-headers': 'content-type, authorization',
        vary: 'Origin, Access-Control-Request-Headers',
        'x-request-id': expect.any(String),
      })
      expect(res.headers['access-control-allow-credentials']).toBeUndefined()
      expect(res.headers['access-control-max-age']).toBeUndefined()
    })

    it('come before the middlewares and explicit OPTIONS routes', async () => {
      const { inject } = await createCorsApp({ origin: APP })

      expect((await inject(preflight('/private'))).status).toBe(204)

      const custom = await inject(preflight('/custom'))
      expect(custom.status).toBe(204)
      expect(custom.headers['access-control-allow-methods']).toBe('OPTIONS')

      // Not a preflight request.
      const plain = await inject({
        method: 'OPTIONS',
        url: '/custom',
        headers: { origin: APP },
      })
      expect(plain.body).toEqual({ custom: true })
    })

    it('use the configured headers and max age', async () => {
      const { inject } = await createCorsApp({
        origin: APP,
        credentials: true,
        allowedHeaders: ['Content-Type', 'X-Api-Key'],
        maxAge: 600,
      })

      const res = await inject(
        preflight('/users', APP, { 'access-control-request-headers': 'x-a' })
      )
      expect(corsHeadersOf(res.headers)).toEqual({
        'access-control-allow-origin': APP,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, HEAD, POST',
        'access-control-allow-headers': 'Content-Type, X-Api-Key',
        'access-control-max-age': '600',
      })
      expect(res.headers.vary).toBe('Origin')
    })

    it('accept max age 0', async () => {
      const { inject } = await createCorsApp({ origin: APP, maxAge: 0 })

      const res = await inject(preflight('/users'))
      expect(res.headers['access-control-max-age']).toBe('0')
    })

    it('answer any origin with "*"', async () => {
      const { inject } = await createCorsApp({ origin: '*' })

      const res = await inject(preflight('/users', EVIL))
      expect(res.status).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('*')
      expect(res.headers['access-control-allow-headers']).toBeUndefined()
      expect(res.headers.vary).toBe('Access-Control-Request-Headers')

      const fixed = await createCorsApp({
        origin: '*',
        allowedHeaders: ['content-type'],
      })
      const res2 = await fixed.inject(preflight('/users', EVIL))
      expect(res2.headers.vary).toBeUndefined()
    })

    it('are handled as usual from other origins or unknown paths', async () => {
      const { inject } = await createCorsApp({ origin: APP })

      const refused = await inject(preflight('/users', EVIL))
      expect(refused.status).toBe(405)
      expect(refused.headers.allow).toBe('GET, HEAD, POST')
      expect(corsHeadersOf(refused.headers)).toEqual({})
      expect(refused.headers.vary).toBe('Origin')

      const unknown = await inject(preflight('/missing'))
      expect(unknown.status).toBe(404)
      expect(unknown.headers['access-control-allow-origin']).toBe(APP)

      const custom = await inject(preflight('/custom', EVIL))
      expect(custom.body).toEqual({ custom: true })
    })

    it('need an Origin and the requested method', async () => {
      const { inject } = await createCorsApp({ origin: APP })

      const noMethod = await inject({
        method: 'OPTIONS',
        url: '/users',
        headers: { origin: APP },
      })
      expect(noMethod.status).toBe(405)
      expect(noMethod.headers['access-control-allow-origin']).toBe(APP)

      // Not an OPTIONS request.
      const get = await inject({ ...preflight('/users'), method: 'GET' })
      expect(get.status).toBe(200)
      expect(corsHeadersOf(get.headers)).toEqual({
        'access-control-allow-origin': APP,
      })

      const noOrigin = await inject({
        method: 'OPTIONS',
        url: '/users',
        headers: { 'access-control-request-method': 'POST' },
      })
      expect(noOrigin.status).toBe(405)
      expect(corsHeadersOf(noOrigin.headers)).toEqual({})
    })

    it('reach the response hooks', async () => {
      const events: ResponseEvent[] = []
      const logger = definePlugin({
        name: 'logger',
        setup(api) {
          api.hooks.onResponse((event) => {
            events.push(event)
          })
        },
      })
      const { inject } = await createCorsApp(
        { origin: APP },
        { plugins: [logger] }
      )

      await inject(preflight('/users'))
      await inject(preflight('/custom'))
      expect(
        events.map(({ response, route }) => [response.status, route?.path])
      ).toEqual([
        [204, undefined],
        [204, '/custom'],
      ])
      expect(events[0]!.response.headers['access-control-allow-origin']).toBe(
        APP
      )
    })
  })

  describe('responses', () => {
    it('get the CORS headers, errors included', async () => {
      const { inject } = await createCorsApp({
        origin: APP,
        credentials: true,
        exposedHeaders: ['x-request-id', 'x-total-count'],
      })
      const expected = {
        'access-control-allow-origin': APP,
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'x-request-id, x-total-count',
      }

      const requests = [
        { url: '/users' },
        { url: '/private' },
        { url: '/boom' },
        { url: '/missing' },
        { method: 'DELETE', url: '/users' },
        { method: 'POST', url: '/users', rawBody: '{oops' },
      ]
      const statuses: number[] = []
      for (const request of requests) {
        const res = await inject({ ...request, headers: { origin: APP } })
        statuses.push(res.status)
        expect(corsHeadersOf(res.headers)).toEqual(expected)
        expect(res.headers.vary).toBe('Origin')
      }
      expect(statuses).toEqual([200, 401, 500, 404, 405, 400])
    })

    it('get the CORS headers on streams', async () => {
      const { dispatch } = await createCorsApp({ origin: APP })

      const res = await dispatch({ url: '/events', headers: { origin: APP } })
      expect(res.body).toBeInstanceOf(ReadableStream)
      expect(res.headers['access-control-allow-origin']).toBe(APP)
      await (res.body as ReadableStream).cancel()
    })

    it('vary on the origin, even without CORS headers', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/users',
            handler: ({ res }) => {
              res.setHeader('vary', 'Accept-Encoding,  Accept')
              return []
            },
          })
          router.defineRoute({
            path: '/any',
            handler: ({ res }) => {
              res.setHeader('vary', '*')
              return []
            },
          })
          router.defineRoute({
            path: '/twice',
            handler: ({ res }) => {
              res.setHeader('vary', ['accept', 'origin'])
              return []
            },
          })
        },
        { cors: { origin: APP } }
      )

      const evil = await inject({ url: '/users', headers: { origin: EVIL } })
      expect(corsHeadersOf(evil.headers)).toEqual({})
      expect(evil.headers.vary).toBe('Accept-Encoding, Accept, Origin')

      const none = await inject({ url: '/users' })
      expect(none.headers.vary).toBe('Accept-Encoding, Accept, Origin')

      expect((await inject({ url: '/any' })).headers.vary).toBe('*')
      expect((await inject({ url: '/twice' })).headers.vary).toBe(
        'accept, origin'
      )
    })

    it('allow any origin with "*"', async () => {
      const { inject } = await createCorsApp({
        origin: '*',
        exposedHeaders: ['x-total-count'],
      })

      for (const headers of [{ origin: EVIL }, {}] as Record<
        string,
        string
      >[]) {
        const res = await inject({ url: '/users', headers })
        expect(corsHeadersOf(res.headers)).toEqual({
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'x-total-count',
        })
        expect(res.headers.vary).toBeUndefined()
      }
    })

    it('get the CORS headers when the request ID cannot be generated', async () => {
      const { inject } = await createCorsApp(
        { origin: APP },
        {
          generateRequestId: () => {
            throw new Error('No ID')
          },
        }
      )

      const res = await inject({ url: '/users', headers: { origin: APP } })
      expect(res.status).toBe(500)
      expect(res.headers['access-control-allow-origin']).toBe(APP)
    })

    it('ignore repeated Origin headers', async () => {
      const { inject } = await createCorsApp({ origin: APP })

      const res = await inject({
        url: '/users',
        headers: { origin: [APP, APP] },
      })
      expect(corsHeadersOf(res.headers)).toEqual({})

      const pattern = await createCorsApp({ origin: /example\.com$/ })
      const res2 = await pattern.inject({
        url: '/users',
        headers: { origin: [EVIL, APP] },
      })
      expect(corsHeadersOf(res2.headers)).toEqual({})
    })
  })

  describe('origin', () => {
    const allowed = async (cors: CorsOptions, origin: string) => {
      const { inject } = await createCorsApp(cors)
      const res = await inject({ url: '/users', headers: { origin } })
      return res.headers['access-control-allow-origin'] === origin
    }

    it('accepts origins and regular expressions', async () => {
      const origin = [APP, /^https:\/\/[a-z]+\.example\.net$/g]

      expect(await allowed({ origin }, APP)).toBe(true)
      expect(await allowed({ origin }, 'https://admin.example.net')).toBe(true)
      expect(await allowed({ origin }, EVIL)).toBe(false)
      expect(await allowed({ origin }, `${APP}.evil.org`)).toBe(false)
      expect(await allowed({ origin: /example\.com$/ }, APP)).toBe(true)
    })

    it('resets global regular expressions', async () => {
      const { inject } = await createCorsApp({ origin: /example\.com$/g })

      for (let index = 0; index < 3; index++) {
        const res = await inject({ url: '/users', headers: { origin: APP } })
        expect(res.headers['access-control-allow-origin']).toBe(APP)
      }
    })

    it('accepts a function', async () => {
      const seen: string[] = []
      const origin = async (value: string, request: { path: string }) => {
        seen.push(`${value} ${request.path}`)
        return value.endsWith('.example.com')
      }

      expect(await allowed({ origin }, APP)).toBe(true)
      expect(await allowed({ origin }, EVIL)).toBe(false)
      const { inject } = await createCorsApp({ origin })
      await inject({ url: '/users' })
      expect(seen).toEqual([`${APP} /users`, `${EVIL} /users`])

      // Only `true` allows the origin.
      expect(await allowed({ origin: () => 1 as never }, APP)).toBe(false)
    })

    it('refuses the origin when the function fails', async () => {
      const logger = silentLogger()
      const failure = new Error('Database unavailable')
      const { inject } = await createCorsApp(
        {
          origin: () => {
            throw failure
          },
        },
        { logger }
      )

      const res = await inject({ url: '/users', headers: { origin: APP } })
      expect(res.status).toBe(200)
      expect(corsHeadersOf(res.headers)).toEqual({})
      expect((await inject(preflight('/users'))).status).toBe(405)
      expect(logger.entries).toContainEqual({
        level: 'error',
        args: [failure, 'CORS origin check failed'],
      })

      const rejected = await createCorsApp(
        { origin: () => Promise.reject('down') },
        { logger }
      )
      await rejected.inject({ url: '/users', headers: { origin: APP } })
      expect(logger.entries).toContainEqual({
        level: 'error',
        args: [{ error: 'down' }, 'CORS origin check failed'],
      })
    })
  })

  describe('api.cors', () => {
    const inspect = (seen: unknown[]) =>
      definePlugin({
        name: 'inspect',
        setup(api) {
          seen.push(api.cors)
          api.addGlobalMiddleware(async ({ req }) => {
            if (api.cors) {
              seen.push(await api.cors.isOriginAllowed(req))
              seen.push(await api.cors.isOriginAllowed({ ...req }))
            }
          })
        },
      })

    it('is undefined when CORS is disabled', async () => {
      const seen: unknown[] = []
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({ path: '/users', handler: () => [] })
        },
        { plugins: [inspect(seen)] }
      )

      await inject({ url: '/users', headers: { origin: APP } })
      expect(seen).toEqual([undefined])
    })

    it('tells whether the origin of a request is allowed', async () => {
      const seen: unknown[] = []
      const checked: string[] = []
      const { inject } = await createCorsApp(
        {
          origin: (origin) => {
            checked.push(origin)
            return origin === APP
          },
          credentials: true,
        },
        { plugins: [inspect(seen)] }
      )

      expect(seen).toEqual([
        { credentials: true, isOriginAllowed: expect.any(Function) },
      ])
      seen.length = 0

      await inject({ url: '/users', headers: { origin: APP } })
      await inject({ url: '/users', headers: { origin: EVIL } })
      await inject({ url: '/users' })
      // A copy of ctx.req is not a request of the app.
      expect(seen).toEqual([true, false, false, false, false, false])
      // Once per request, for the plugin and the headers.
      expect(checked).toEqual([APP, EVIL])
    })

    it('reports credentials: false', async () => {
      const seen: unknown[] = []
      await createCorsApp({ origin: '*' }, { plugins: [inspect(seen)] })
      expect(seen).toEqual([
        { credentials: false, isOriginAllowed: expect.any(Function) },
      ])
    })
  })

  describe('validation', () => {
    const create = (cors: unknown) =>
      createTestApp(() => {}, { cors: cors as CorsOptions })

    it.each([
      [null, 'expected an object'],
      [[APP], 'expected an object'],
      ['https://app.example.com', 'expected an object'],
      [{}, 'origin is required'],
      [{ origin: [] }, 'origin is required'],
      [{ origin: 42 }, 'origin must be'],
      [{ origin: [APP, 42] }, 'origin must be'],
      [{ origin: `${APP}/` }, 'is not an origin'],
      [{ origin: 'https://App.example.com' }, 'is not an origin'],
      [{ origin: 'app.example.com' }, 'is not an origin'],
      [{ origin: ['*', APP] }, 'is not an origin'],
      [{ origin: '*', credentials: true }, 'cannot be combined'],
      [{ origin: APP, credentials: 'yes' }, 'credentials must be a boolean'],
      [{ origin: APP, allowedHeaders: 'content-type' }, 'allowedHeaders'],
      [{ origin: APP, allowedHeaders: ['bad header'] }, 'allowedHeaders'],
      [{ origin: APP, exposedHeaders: [42] }, 'exposedHeaders'],
      [{ origin: APP, maxAge: -1 }, 'maxAge'],
      [{ origin: APP, maxAge: 1.5 }, 'maxAge'],
      [{ origin: APP, methods: ['GET'] }, 'unknown option "methods"'],
    ])('rejects %j', async (cors, message) => {
      await expect(create(cors)).rejects.toThrow(
        expect.objectContaining({
          name: 'TypeError',
          message: expect.stringContaining(message),
        })
      )
    })

    it('accepts valid options', async () => {
      await expect(
        create({
          origin: ['http://localhost:3000', APP],
          credentials: true,
          allowedHeaders: [],
          exposedHeaders: ['*'],
          maxAge: 0,
        })
      ).resolves.toBeDefined()
    })
  })
})
