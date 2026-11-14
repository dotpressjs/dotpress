import {
  createApp,
  createRouter,
  file,
  json,
  stream,
  text,
  type Router,
} from '@dotpress/core'
import {
  createMemoryLogger,
  memoryAdapter,
  toLambdaEvent,
  type LambdaEventFormat,
} from '@dotpress/testing'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fastifyAdapter, type FastifyAdapterOptions } from '../src/index.js'
import {
  createLambdaHandler,
  type LambdaEvent,
  type LambdaHandler,
} from '../src/lambda.js'

const routerWith = (define: (router: Router) => void) => {
  const router = createRouter()
  define(router)
  return router
}

const hello = routerWith((router) => {
  router.defineRoute({ path: '/hello', handler: () => ({ hi: 1 }) })
})

const closing: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(closing.splice(0).map((item) => item.close()))
  vi.restoreAllMocks()
})

const createFastifyApp = async (
  router = hello,
  options: FastifyAdapterOptions<ReturnType<typeof Fastify>> = {}
) => {
  const app = await createApp({
    adapter: fastifyAdapter(options),
    logger: createMemoryLogger(),
    routers: [router],
  })
  closing.push(app)
  return app
}

type EventRecord = Record<string, unknown> & {
  headers?: Record<string, string>
  multiValueHeaders?: Record<string, string[]>
}

const event = async (
  path: string,
  format: LambdaEventFormat = 'v2',
  init?: RequestInit,
  sourceIp?: string
) =>
  (await toLambdaEvent(
    new Request(new URL(path, 'https://api.example.com'), init),
    format,
    sourceIp
  )) as EventRecord

/** Load balancer event without multi-value headers. */
const singleValueAlb = async (path: string, init?: RequestInit) => {
  const { multiValueHeaders, multiValueQueryStringParameters, ...rest } =
    await event(path, 'alb', init, '203.0.113.9')
  const query = multiValueQueryStringParameters as Record<string, string[]>
  return {
    ...rest,
    headers: Object.fromEntries(
      Object.entries(multiValueHeaders!).map(([name, values]) => [
        name,
        values.at(-1)!,
      ])
    ),
    queryStringParameters: Object.fromEntries(
      Object.entries(query).map(([key, values]) => [key, values.at(-1)!])
    ),
  }
}

const invoke = async (
  handler: LambdaHandler,
  path: string,
  format?: LambdaEventFormat
) => handler(await event(path, format))

const INTERNAL_ERROR = JSON.stringify({
  status: 500,
  error: 'INTERNAL_ERROR',
  message: 'Internal Server Error',
})

describe('createLambdaHandler()', () => {
  it('rejects unknown options', () => {
    expect(() =>
      createLambdaHandler(() => createFastifyApp(), {
        binary: () => true,
      } as never)
    ).toThrow(new TypeError('createLambdaHandler(): unknown option "binary".'))
  })

  it('creates the app at the first invocation, then reuses it', async () => {
    const factory = vi.fn(() => createFastifyApp())
    const handler = createLambdaHandler(factory)
    expect(factory).not.toHaveBeenCalled()

    for (let index = 0; index < 3; index++) {
      const result = await invoke(handler, '/hello')
      expect(result).toMatchObject({ statusCode: 200, body: '{"hi":1}' })
    }
    expect(factory).toHaveBeenCalledOnce()
  })

  it('makes concurrent invocations wait for the same app', async () => {
    let resolve!: () => void
    const started = new Promise<void>((done) => {
      resolve = done
    })
    const factory = vi.fn(async () => {
      await started
      return createFastifyApp()
    })
    const handler = createLambdaHandler(factory)

    const pending = [invoke(handler, '/hello'), invoke(handler, '/hello')]
    resolve()

    for (const result of await Promise.all(pending)) {
      expect(result.statusCode).toBe(200)
    }
    expect(factory).toHaveBeenCalledOnce()
  })

  it('accepts an app created beforehand', async () => {
    const app = await createFastifyApp()
    const handler = createLambdaHandler(() => app)

    expect((await invoke(handler, '/hello')).statusCode).toBe(200)
  })

  it('answers 500 and retries when the app cannot be created', async () => {
    const logger = createMemoryLogger()
    const failure = new Error('Database unavailable')
    const factory = vi
      .fn<() => Promise<Awaited<ReturnType<typeof createFastifyApp>>>>()
      .mockRejectedValueOnce(failure)
      .mockImplementation(() => createFastifyApp())
    const handler = createLambdaHandler(factory, { logger })

    const contentType = 'application/json; charset=utf-8'
    const failed = await invoke(handler, '/hello', 'v2')
    expect(failed).toMatchObject({
      statusCode: 500,
      body: INTERNAL_ERROR,
      headers: { 'content-type': contentType },
    })

    factory.mockRejectedValueOnce(failure)
    const post = await event('/hello', 'v1', { method: 'POST', body: '{}' })
    expect(await handler(post)).toMatchObject({
      statusCode: 500,
      body: INTERNAL_ERROR,
      headers: { 'content-type': contentType },
    })

    factory.mockRejectedValueOnce(failure)
    expect(await invoke(handler, '/hello', 'alb')).toMatchObject({
      statusCode: 500,
      body: INTERNAL_ERROR,
      multiValueHeaders: { 'content-type': [contentType] },
    })

    expect(logger.entries).toContainEqual({
      level: 'error',
      args: [failure, 'Failed to create the app'],
    })

    // Retried at the next invocation.
    expect((await invoke(handler, '/hello')).statusCode).toBe(200)
    expect(factory).toHaveBeenCalledTimes(4)
  })

  it('logs to the console by default', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = createLambdaHandler(() =>
      Promise.reject(new Error('Missing configuration'))
    )

    expect((await invoke(handler, '/hello')).statusCode).toBe(500)
    expect(error).toHaveBeenCalledWith('Failed to create the app', {
      err: expect.objectContaining({ message: 'Missing configuration' }),
    })
  })

  it('needs an app created with fastifyAdapter()', async () => {
    const logger = createMemoryLogger()
    const app = await createApp({
      adapter: memoryAdapter(),
      logger: createMemoryLogger(),
      routers: [hello],
    })
    // Also rejected by the types.
    const handler = createLambdaHandler(() => app as never, { logger })

    expect((await invoke(handler, '/hello')).statusCode).toBe(500)
    expect(logger.entries).toContainEqual({
      level: 'error',
      args: [
        expect.objectContaining({
          message: expect.stringContaining('fastifyAdapter()'),
        }),
        'Failed to create the app',
      ],
    })
  })

  it('serves the native routes', async () => {
    const handler = createLambdaHandler(() =>
      createFastifyApp(hello, {
        beforeRoutes: (app) => {
          app.get('/native', async () => ({ native: true }))
        },
      })
    )

    expect(await invoke(handler, '/native')).toMatchObject({
      statusCode: 200,
      body: '{"native":true}',
    })
  })

  it('answers 500 when a streamed body fails', async () => {
    // Logged by @fastify/aws-lambda.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handler = createLambdaHandler(() =>
      createFastifyApp(
        routerWith((router) => {
          router.defineRoute({
            path: '/broken',
            handler: () =>
              stream(async function* () {
                yield 'partial'
                throw new Error('Source failed')
              }),
          })
        })
      )
    )

    // Instead of a truncated response.
    expect(await invoke(handler, '/broken')).toEqual({
      statusCode: 500,
      headers: {},
      body: '',
    })
    expect(error).toHaveBeenCalled()
  })

  it('sends binary and compressed responses in base64', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 255])
    const router = routerWith((router) => {
      router.defineRoute({ path: '/file', handler: () => file(bytes) })
      router.defineRoute({
        path: '/csv',
        handler: () => stream(['a,b\n'], { contentType: 'text/csv' }),
      })
      router.defineRoute({
        path: '/compressed',
        handler: ({ res }) => {
          res.setHeader('content-encoding', 'gzip')
          return text('compressed')
        },
      })
      router.defineRoute({
        path: '/identity',
        handler: ({ res }) => {
          res.setHeader('content-encoding', 'identity')
          return text('plain')
        },
      })
    })

    const handler = createLambdaHandler(() => createFastifyApp(router))
    expect(await invoke(handler, '/file')).toMatchObject({
      isBase64Encoded: true,
      body: 'AAEC/w==',
    })
    expect(await invoke(handler, '/csv')).toMatchObject({
      isBase64Encoded: false,
      body: 'a,b\n',
    })
    expect(await invoke(handler, '/compressed')).toMatchObject({
      isBase64Encoded: true,
      body: btoa('compressed'),
    })
    expect(await invoke(handler, '/identity')).toMatchObject({
      isBase64Encoded: false,
      body: 'plain',
    })

    const custom = createLambdaHandler(() => createFastifyApp(router), {
      isContentTypeBinary: (type) => type.startsWith('text/csv'),
    })
    expect(await invoke(custom, '/csv')).toMatchObject({
      isBase64Encoded: true,
      body: btoa('a,b\n'),
    })
  })

  it('sends several cookies in every format', async () => {
    const handler = createLambdaHandler(() =>
      createFastifyApp(
        routerWith((router) => {
          router.defineRoute({
            path: '/login',
            handler: ({ res }) => {
              res.setCookie('a', '1')
              res.setCookie('b', '2')
              return json({ ok: true })
            },
          })
        })
      )
    )

    expect(await invoke(handler, '/login', 'v2')).toMatchObject({
      cookies: ['a=1; Path=/', 'b=2; Path=/'],
    })
    for (const format of ['v1', 'alb'] as const) {
      expect(await invoke(handler, '/login', format)).toMatchObject({
        multiValueHeaders: { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] },
      })
    }
  })

  describe('query string', () => {
    const queryApp = () =>
      createFastifyApp(
        routerWith((router) => {
          router.defineRoute({
            path: '/search',
            handler: ({ req }) => req.query,
          })
        })
      )

    it('keeps the commas of the values (payload v2)', async () => {
      const handler = createLambdaHandler(queryApp)
      const v2 = await event('/search?tag=a&tag=b&list=x,y')
      // Sent by API Gateway along with the raw query string.
      v2.queryStringParameters = { tag: 'a,b', list: 'x,y' }

      expect(JSON.parse((await handler(v2)).body)).toEqual({
        tag: ['a', 'b'],
        list: 'x,y',
      })
    })

    it('reads the single-value parameters of load balancers', async () => {
      const handler = createLambdaHandler(queryApp)
      const result = await handler(
        await singleValueAlb('/search?q=hello+world&name=%C3%A9')
      )

      expect(result).toMatchObject({
        statusCode: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
      expect(result.multiValueHeaders).toBeUndefined()
      expect(JSON.parse(result.body)).toEqual({ q: 'hello world', name: 'é' })
    })
  })

  describe('client IP address', () => {
    const ipApp = () =>
      createFastifyApp(
        routerWith((router) => {
          router.defineRoute({
            path: '/ip',
            handler: ({ req }) => req.ip ?? null,
          })
        })
      )

    const ipOf = async (
      handler: LambdaHandler,
      lambdaEvent: LambdaEvent | Promise<LambdaEvent>
    ) => JSON.parse((await handler(await lambdaEvent)).body) as string | null

    const spoofed = { headers: { 'x-forwarded-for': '198.51.100.1' } }

    it('takes the source IP of API Gateway', async () => {
      const handler = createLambdaHandler(ipApp)

      for (const format of ['v1', 'v2'] as const) {
        expect(
          await ipOf(handler, event('/ip', format, spoofed, '203.0.113.9'))
        ).toBe('203.0.113.9')
      }
    })

    it('takes the address appended by the load balancer', async () => {
      const handler = createLambdaHandler(ipApp)

      expect(
        await ipOf(handler, event('/ip', 'alb', undefined, '203.0.113.9'))
      ).toBe('203.0.113.9')
      expect(
        await ipOf(handler, event('/ip', 'alb', spoofed, '203.0.113.9'))
      ).toBe('203.0.113.9')
      expect(await ipOf(handler, singleValueAlb('/ip', spoofed))).toBe(
        '203.0.113.9'
      )

      // Header sent several times by the client.
      const repeated = await event('/ip', 'alb')
      repeated.multiValueHeaders!['x-forwarded-for'] = [
        '198.51.100.1',
        '198.51.100.2, 203.0.113.9',
      ]
      expect(await ipOf(handler, repeated)).toBe('203.0.113.9')
    })

    it('falls back to the address of inject() without header', async () => {
      const handler = createLambdaHandler(ipApp)
      const alb = await event('/ip', 'alb')
      delete alb.multiValueHeaders!['x-forwarded-for']

      expect(await ipOf(handler, alb)).toBe('127.0.0.1')
    })
  })
})
