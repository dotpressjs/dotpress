import {
  createApp,
  createRouter,
  file,
  json,
  stream,
  type Router,
} from '@dotpress/core'
import {
  createMemoryLogger,
  memoryAdapter,
  toLambdaEvent,
  type LambdaEventFormat,
} from '@dotpress/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { honoAdapter } from '../src/index.js'
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

const createHonoApp = async (router = hello) => {
  const app = await createApp({
    adapter: honoAdapter(),
    logger: createMemoryLogger(),
    routers: [router],
  })
  closing.push(app)
  return app
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
  )) as unknown as LambdaEvent

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
      createLambdaHandler(() => createHonoApp(), {
        binary: () => true,
      } as never)
    ).toThrow(new TypeError('createLambdaHandler(): unknown option "binary".'))
  })

  it('creates the app at the first invocation, then reuses it', async () => {
    const factory = vi.fn(() => createHonoApp())
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
      return createHonoApp()
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
    const app = await createHonoApp()
    const handler = createLambdaHandler(() => app)

    expect((await invoke(handler, '/hello')).statusCode).toBe(200)
  })

  it('answers 500 and retries when the app cannot be created', async () => {
    const logger = createMemoryLogger()
    const failure = new Error('Database unavailable')
    const factory = vi
      .fn<() => Promise<Awaited<ReturnType<typeof createHonoApp>>>>()
      .mockRejectedValueOnce(failure)
      .mockImplementation(() => createHonoApp())
    const handler = createLambdaHandler(factory, { logger })

    for (const format of ['v1', 'alb'] as const) {
      factory.mockRejectedValueOnce(failure)
      const result = await invoke(handler, '/hello', format)
      expect(result).toMatchObject({
        statusCode: 500,
        body: INTERNAL_ERROR,
        multiValueHeaders: {
          'content-type': ['application/json; charset=utf-8'],
        },
      })
    }

    const failed = await invoke(handler, '/hello', 'v2')
    expect(failed).toMatchObject({
      statusCode: 500,
      body: INTERNAL_ERROR,
      headers: { 'content-type': 'application/json; charset=utf-8' },
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

  it('needs an app created with honoAdapter()', async () => {
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
          message: expect.stringContaining('honoAdapter()'),
        }),
        'Failed to create the app',
      ],
    })
  })

  it('fails the invocation when a streamed body fails', async () => {
    const handler = createLambdaHandler(() =>
      createHonoApp(
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

    // API Gateway answers 502 instead of a truncated response.
    await expect(invoke(handler, '/broken')).rejects.toThrow('Source failed')
  })

  it('sends binary responses in base64', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 255])
    const router = routerWith((router) => {
      router.defineRoute({ path: '/file', handler: () => file(bytes) })
      router.defineRoute({
        path: '/csv',
        handler: () => stream(['a,b\n'], { contentType: 'text/csv' }),
      })
    })

    const handler = createLambdaHandler(() => createHonoApp(router))
    expect(await invoke(handler, '/file')).toMatchObject({
      isBase64Encoded: true,
      body: 'AAEC/w==',
    })
    expect(await invoke(handler, '/csv')).toMatchObject({
      isBase64Encoded: false,
      body: 'a,b\n',
    })

    const custom = createLambdaHandler(() => createHonoApp(router), {
      isContentTypeBinary: (type) => type.startsWith('text/csv'),
    })
    expect(await invoke(custom, '/csv')).toMatchObject({
      isBase64Encoded: true,
      body: btoa('a,b\n'),
    })
  })

  it('sends several cookies in every format', async () => {
    const handler = createLambdaHandler(() =>
      createHonoApp(
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

  describe('client IP address', () => {
    const ipApp = (getIp?: () => string) =>
      createApp({
        adapter: honoAdapter(getIp ? { getIp } : {}),
        logger: createMemoryLogger(),
        routers: [
          routerWith((router) => {
            router.defineRoute({
              path: '/ip',
              handler: ({ req }) => req.ip ?? null,
            })
          }),
        ],
      })

    const ipOf = async (
      handler: LambdaHandler,
      format: LambdaEventFormat,
      init?: RequestInit
    ) => {
      const result = await handler(
        await event('/ip', format, init, '203.0.113.9')
      )
      return JSON.parse(result.body) as string | null
    }

    it('takes the source IP of API Gateway', async () => {
      const handler = createLambdaHandler(() => ipApp())
      const spoofed = { headers: { 'x-forwarded-for': '198.51.100.1' } }

      expect(await ipOf(handler, 'v1', spoofed)).toBe('203.0.113.9')
      expect(await ipOf(handler, 'v2', spoofed)).toBe('203.0.113.9')
    })

    it('takes the address appended by the load balancer', async () => {
      const handler = createLambdaHandler(() => ipApp())

      expect(await ipOf(handler, 'alb')).toBe('203.0.113.9')
      expect(
        await ipOf(handler, 'alb', {
          headers: { 'x-forwarded-for': '198.51.100.1' },
        })
      ).toBe('203.0.113.9')
    })

    it('has no address without load balancer header', async () => {
      const handler = createLambdaHandler(() => ipApp())
      const alb = (await event('/ip', 'alb')) as unknown as {
        multiValueHeaders: Record<string, string[]>
      }
      delete alb.multiValueHeaders['x-forwarded-for']

      const result = await handler(alb as unknown as LambdaEvent)
      expect(JSON.parse(result.body)).toBeNull()
    })

    it('uses getIp when given', async () => {
      const handler = createLambdaHandler(() => ipApp(() => '192.0.2.1'))
      expect(await ipOf(handler, 'v2')).toBe('192.0.2.1')
    })
  })
})
