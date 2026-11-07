import {
  DEFAULT_BODY_LIMIT,
  createRouter,
  file,
  json,
  notFoundError,
  redirect,
  sse,
  stream,
  text,
  unauthorizedError,
  type AppOptions,
  type Middleware,
  type Router,
} from '@dotpress/core'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from './logger.js'

/**
 * Running application under test.
 */
export interface ConformanceTarget {
  /** Sends a request to the application. `path` includes the query. */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** Stops the application. */
  close(): Promise<void>
}

export type ConformanceAppOptions = Omit<AppOptions, 'adapter'>

export interface ConformanceSuiteOptions {
  /** Adapter name, used in test titles. */
  name: string
  /**
   * Creates an app with the adapter under test and the given options, and
   * starts it. Called once per test.
   */
  setup(options: ConformanceAppOptions): Promise<ConformanceTarget>
}

/**
 * Target for adapters listening on an HTTP port.
 */
export const createHttpTarget = (
  baseUrl: string,
  close: () => Promise<void>
): ConformanceTarget => ({
  fetch: (path, init) => fetch(new URL(path, baseUrl), init),
  close,
})

const TIMEOUT = 2000

const within = <T>(promise: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for: ${label}`)),
        TIMEOUT
      )
    ),
  ])

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

const readChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const { done, value } = await reader.read()
  return done ? undefined : new TextDecoder().decode(value)
}

/**
 * Registers the adapter conformance suite (vitest). An adapter is ready
 * when it passes every test.
 */
export const runConformanceSuite = (options: ConformanceSuiteOptions) => {
  const serve = async (
    define: (router: Router) => void,
    appOptions: Omit<ConformanceAppOptions, 'routers'> = {}
  ) => {
    const router = createRouter()
    define(router)
    return options.setup({
      logger: createMemoryLogger(),
      ...appOptions,
      routers: [router],
    })
  }

  const withApp = async (
    define: (router: Router) => void,
    run: (target: ConformanceTarget) => Promise<void>,
    appOptions?: Omit<ConformanceAppOptions, 'routers'>
  ) => {
    const target = await serve(define, appOptions)
    try {
      await run(target)
    } finally {
      await target.close()
    }
  }

  const postJson = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  describe(`${options.name} adapter conformance`, () => {
    describe('routing', () => {
      it('serves JSON results', () =>
        withApp(
          (router) => {
            router.defineRoute({ path: '/hello', handler: () => ({ hi: 1 }) })
          },
          async ({ fetch }) => {
            const res = await fetch('/hello')

            expect(res.status).toBe(200)
            expect(res.headers.get('content-type')).toBe(
              'application/json; charset=utf-8'
            )
            expect(await res.json()).toEqual({ hi: 1 })
          }
        ))

      it('routes every HTTP method', () =>
        withApp(
          (router) => {
            for (const method of [
              'get',
              'post',
              'put',
              'patch',
              'delete',
              'options',
            ] as const) {
              router.defineRoute({
                method,
                path: '/resource',
                handler: ({ req }) => ({ method: req.method }),
              })
            }
            router.defineRoute({
              method: 'head',
              path: '/resource',
              handler: ({ res }) => {
                res.setHeader('x-head', 'yes')
              },
            })
          },
          async ({ fetch }) => {
            for (const method of [
              'GET',
              'POST',
              'PUT',
              'PATCH',
              'DELETE',
              'OPTIONS',
            ]) {
              const res = await fetch('/resource', { method })
              expect(await res.json()).toEqual({ method })
            }

            const head = await fetch('/resource', { method: 'HEAD' })
            expect(head.headers.get('x-head')).toBe('yes')
          }
        ))

      it('extracts decoded path parameters', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/orgs/:orgId/files/:name',
              handler: ({ req }) => req.params,
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/orgs/acme/files/a%20b%2Fc%C3%A9')
            expect(await res.json()).toEqual({ orgId: 'acme', name: 'a b/cé' })
          }
        ))

      it('gives static segments priority over parameters', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/users/:id',
              handler: ({ req }) => ({ id: req.params.id }),
            })
            router.defineRoute({ path: '/users/me', handler: () => 'me' })
          },
          async ({ fetch }) => {
            expect(await (await fetch('/users/me')).json()).toBe('me')
            expect(await (await fetch('/users/42')).json()).toEqual({
              id: '42',
            })
          }
        ))

      it('ignores trailing slashes and matches case-sensitively', () =>
        withApp(
          (router) => {
            router.defineRoute({ path: '/users', handler: () => 'users' })
          },
          async ({ fetch }) => {
            expect((await fetch('/users/')).status).toBe(200)
            expect((await fetch('/Users')).status).toBe(404)
          }
        ))

      it('returns the standard 404 error for unknown paths', () =>
        withApp(
          (router) => {
            router.defineRoute({ path: '/items', handler: () => [] })
          },
          async ({ fetch }) => {
            for (const method of ['GET', 'POST']) {
              const res = await fetch('/missing', { method })

              expect(res.status).toBe(404)
              expect(res.headers.get('x-request-id')).toBeTruthy()
              expect(await res.json()).toEqual({
                status: 404,
                error: 'NOT_FOUND',
                message: 'Route not found',
              })
            }
          }
        ))

      it('returns 405 with an Allow header for unsupported methods', () =>
        withApp(
          (router) => {
            router.defineRoute({ path: '/items/:id', handler: () => ({}) })
            router.defineRoute({
              method: 'delete',
              path: '/items/:id',
              handler: () => {},
            })
          },
          async ({ fetch }) => {
            for (const method of ['POST', 'OPTIONS']) {
              const res = await fetch('/items/1', { method })

              expect(res.status).toBe(405)
              expect(res.headers.get('allow')).toBe('GET, HEAD, DELETE')
              expect(res.headers.get('x-request-id')).toBeTruthy()
              expect(await res.json()).toEqual({
                status: 405,
                error: 'METHOD_NOT_ALLOWED',
                message: 'Method not allowed',
              })
            }
          }
        ))

      it('answers HEAD requests with the GET route, without body', () =>
        withApp(
          (router) => {
            router.defineRoute({ path: '/data', handler: () => ({ a: 1 }) })
            router.defineRoute({
              path: '/stream',
              handler: () => stream(['never sent']),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/data', { method: 'HEAD' })
            expect(res.status).toBe(200)
            expect(res.headers.get('content-type')).toBe(
              'application/json; charset=utf-8'
            )
            expect(await res.text()).toBe('')

            const streamed = await fetch('/stream', { method: 'HEAD' })
            expect(streamed.status).toBe(200)
            expect(await streamed.text()).toBe('')
          }
        ))

      it('mounts groups with their prefix and middlewares', () => {
        const calls: string[] = []
        const track =
          (name: string): Middleware =>
          () => {
            calls.push(name)
          }

        return withApp(
          (router) => {
            const api = router.createGroup('/api', [track('api')])
            api.createGroup('/admin', [track('admin')]).defineRoute({
              path: '/stats',
              middlewares: [track('route')],
              handler: () => ({ ok: true }),
            })
          },
          async ({ fetch }) => {
            expect(await (await fetch('/api/admin/stats')).json()).toEqual({
              ok: true,
            })
            expect(calls).toEqual(['global', 'api', 'admin', 'route'])
          },
          { middlewares: [track('global')] }
        )
      })
    })

    describe('request', () => {
      it('parses the query string', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/search',
              handler: ({ req }) => req.query,
            })
          },
          async ({ fetch }) => {
            const res = await fetch(
              '/search?q=hello+world&tag=a&tag=b&name=%C3%A9&empty='
            )
            expect(await res.json()).toEqual({
              q: 'hello world',
              tag: ['a', 'b'],
              name: 'é',
              empty: '',
            })
          }
        ))

      it('exposes the method, path, URL, headers and cookies', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/inspect',
              handler: ({ req }) => ({
                method: req.method,
                path: req.path,
                url:
                  req.url &&
                  new URL(req.url).pathname + new URL(req.url).search,
                custom: req.header('X-Custom'),
                lowercase: req.headers['x-custom'],
                cookies: req.cookies,
              }),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/inspect?a=1', {
              method: 'POST',
              headers: {
                'X-Custom': 'value',
                cookie: 'session=abc; theme=dark%20blue',
              },
            })

            expect(await res.json()).toEqual({
              method: 'POST',
              path: '/inspect',
              url: '/inspect?a=1',
              custom: 'value',
              lowercase: 'value',
              cookies: { session: 'abc', theme: 'dark blue' },
            })
          }
        ))

      it('parses JSON bodies', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/echo',
              handler: ({ req }) => ({ body: req.body }),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/echo', postJson({ a: [1, 'é'], b: null }))
            expect(await res.json()).toEqual({ body: { a: [1, 'é'], b: null } })
          }
        ))

      it('rejects malformed JSON bodies', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/echo',
              handler: () => ({ unreachable: true }),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/echo', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{"broken":',
            })

            expect(res.status).toBe(400)
            expect(res.headers.get('x-request-id')).toBeTruthy()
            expect(await res.json()).toEqual({
              status: 400,
              error: 'MALFORMED_BODY',
              message: 'Malformed request body',
            })
          }
        ))

      it('parses URL-encoded, text and binary bodies', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/echo',
              handler: ({ req }) =>
                req.body instanceof Uint8Array
                  ? { bytes: [...req.body] }
                  : { body: req.body },
            })
          },
          async ({ fetch }) => {
            const form = await fetch('/echo', {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: 'name=Ada+Lovelace&tag=a&tag=b',
            })
            expect(await form.json()).toEqual({
              body: { name: 'Ada Lovelace', tag: ['a', 'b'] },
            })

            const plain = await fetch('/echo', {
              method: 'POST',
              headers: { 'content-type': 'text/plain; charset=utf-8' },
              body: 'héllo',
            })
            expect(await plain.json()).toEqual({ body: 'héllo' })

            const binary = await fetch('/echo', {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: new Uint8Array([0, 1, 254, 255]),
            })
            expect(await binary.json()).toEqual({ bytes: [0, 1, 254, 255] })
          }
        ))

      it('exposes the raw body on rawBody routes', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/webhooks',
              rawBody: true,
              schema: (z) => ({ body: z.object({ type: z.string() }) }),
              handler: ({ req }) => ({
                raw: new TextDecoder().decode(req.rawBody),
                type: req.body.type,
              }),
            })
            router.defineRoute({
              method: 'post',
              path: '/ping',
              rawBody: true,
              handler: ({ req }) => ({ length: req.rawBody.byteLength }),
            })
          },
          async ({ fetch }) => {
            // Whitespace and key order must be preserved for signatures.
            const payload = '{ "type" :  "invoice.paid", "id": "é" }'
            const res = await fetch('/webhooks', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: payload,
            })
            expect(await res.json()).toEqual({
              raw: payload,
              type: 'invoice.paid',
            })

            const empty = await fetch('/ping', { method: 'POST' })
            expect(await empty.json()).toEqual({ length: 0 })
          }
        ))

      it('gives an undefined body when there is none', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/empty',
              handler: ({ req }) => ({ hasBody: req.body !== undefined }),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/empty', { method: 'POST' })
            expect(await res.json()).toEqual({ hasBody: false })
          }
        ))

      it('rejects bodies larger than the default limit', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/upload',
              handler: () => ({ unreachable: true }),
            })
          },
          async ({ fetch }) => {
            const payload = new Uint8Array(DEFAULT_BODY_LIMIT + 1)

            const declared = await fetch('/upload', {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: payload,
            })
            expect(declared.status).toBe(413)
            expect(await declared.json()).toEqual({
              status: 413,
              error: 'PAYLOAD_TOO_LARGE',
              message: 'Request body too large',
            })

            // Chunked body, without Content-Length.
            const chunked = await fetch('/upload', {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(payload.subarray(0, DEFAULT_BODY_LIMIT))
                  controller.enqueue(new Uint8Array(1))
                  controller.close()
                },
              }),
              duplex: 'half',
            } as RequestInit)
            expect(chunked.status).toBe(413)
          }
        ))

      it('accepts bodies up to the default limit', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/upload',
              handler: ({ req }) => ({
                size: (req.body as Uint8Array).byteLength,
              }),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/upload', {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: new Uint8Array(DEFAULT_BODY_LIMIT),
            })
            expect(await res.json()).toEqual({ size: DEFAULT_BODY_LIMIT })
          }
        ))

      it('rejects compressed request bodies', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/echo',
              handler: () => ({ unreachable: true }),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/echo', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-encoding': 'gzip',
              },
              body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
            })

            expect(res.status).toBe(415)
            expect(await res.json()).toMatchObject({
              error: 'UNSUPPORTED_MEDIA_TYPE',
            })
          }
        ))
    })

    describe('validation', () => {
      it('returns VALIDATION_FAILED errors and parsed values', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/users/:id',
              schema: (z) => ({
                params: z.object({ id: z.coerce.number().int() }),
                query: z.object({ notify: z.enum(['yes', 'no']) }),
                body: z.object({ name: z.string().trim() }),
              }),
              handler: ({ req }) => ({
                id: req.params.id,
                notify: req.query.notify,
                name: req.body.name,
              }),
            })
          },
          async ({ fetch }) => {
            const invalid = await fetch('/users/abc?notify=maybe', postJson({}))
            expect(invalid.status).toBe(400)
            expect(await invalid.json()).toMatchObject({
              status: 400,
              error: 'VALIDATION_FAILED',
              data: {
                issues: [
                  { source: 'params', path: ['id'] },
                  { source: 'query', path: ['notify'] },
                  { source: 'body', path: ['name'] },
                ],
              },
            })

            const valid = await fetch(
              '/users/42?notify=yes',
              postJson({ name: '  Ada ' })
            )
            expect(await valid.json()).toEqual({
              id: 42,
              notify: 'yes',
              name: 'Ada',
            })
          }
        ))
    })

    describe('errors', () => {
      it('serializes returned and thrown HTTP errors', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/returned',
              handler: () => notFoundError('User not found', { id: '1' }),
            })
            router.defineRoute({
              path: '/thrown',
              handler: ({ res }) => {
                res.setHeader('www-authenticate', 'Bearer')
                throw unauthorizedError()
              },
            })
          },
          async ({ fetch }) => {
            const returned = await fetch('/returned')
            expect(returned.status).toBe(404)
            expect(await returned.json()).toEqual({
              status: 404,
              error: 'NOT_FOUND',
              message: 'User not found',
              data: { id: '1' },
            })

            const thrown = await fetch('/thrown')
            expect(thrown.status).toBe(401)
            expect(thrown.headers.get('www-authenticate')).toBe('Bearer')
            expect(await thrown.json()).toEqual({
              status: 401,
              error: 'UNAUTHORIZED',
              message: 'Unauthorized',
            })
          }
        ))

      it('hides unexpected errors behind a 500 error and reports them', async () => {
        const onError = vi.fn()

        await withApp(
          (router) => {
            router.defineRoute({
              path: '/crash',
              handler: () => {
                throw new Error('Database password is hunter2')
              },
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/crash')

            expect(res.status).toBe(500)
            expect(res.headers.get('x-request-id')).toBeTruthy()
            expect(await res.json()).toEqual({
              status: 500,
              error: 'INTERNAL_ERROR',
              message: 'Internal Server Error',
            })
            expect(onError).toHaveBeenCalledOnce()
          },
          { onError }
        )
      })

      it('exposes error details when exposeErrors is enabled', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/crash',
              handler: () => {
                throw new Error('Boom')
              },
            })
          },
          async ({ fetch }) => {
            expect(await (await fetch('/crash')).json()).toMatchObject({
              status: 500,
              data: { name: 'Error', message: 'Boom' },
            })
          },
          { exposeErrors: true }
        ))

      it('returns a 500 error when the response does not match its schema', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/invalid',
              schema: (z) => ({ response: z.object({ id: z.string() }) }),
              // @ts-expect-error the result does not match the schema
              handler: () => ({ id: 1 }),
            })
          },
          async ({ fetch }) => {
            expect((await fetch('/invalid')).status).toBe(500)
          }
        ))
    })

    describe('middlewares and filters', () => {
      it('stops the pipeline when a middleware returns a response', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/private',
              middlewares: [
                ({ req }) =>
                  req.header('authorization') ? undefined : unauthorizedError(),
              ],
              handler: () => ({ secret: true }),
            })
            router.defineRoute({
              path: '/legacy',
              middlewares: [() => redirect('/modern', 301)],
              handler: () => ({ unreachable: true }),
            })
          },
          async ({ fetch }) => {
            expect((await fetch('/private')).status).toBe(401)
            expect(
              await (
                await fetch('/private', { headers: { authorization: 'x' } })
              ).json()
            ).toEqual({ secret: true })

            const legacy = await fetch('/legacy', { redirect: 'manual' })
            expect(legacy.status).toBe(301)
            expect(legacy.headers.get('location')).toBe('/modern')
          }
        ))

      it('applies app and router response filters', () =>
        withApp(
          (router) => {
            router.addResponseFilter((_ctx, result) => ({
              ...(result as object),
              router: true,
            }))
            router.defineRoute({ path: '/data', handler: () => ({ a: 1 }) })
          },
          async ({ fetch }) => {
            expect(await (await fetch('/data')).json()).toEqual({
              a: 1,
              app: true,
              router: true,
            })
          },
          {
            responseFilters: [
              (_ctx, result) => ({ ...(result as object), app: true }),
            ],
          }
        ))
    })

    describe('responses', () => {
      it('applies statuses, headers and cookies', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'post',
              path: '/created',
              status: 201,
              handler: ({ res }) => {
                res.setHeader('location', '/items/1')
                res.setCookie('session', 'abc', { httpOnly: true })
                res.setCookie('theme', 'dark')
                return { id: 1 }
              },
            })
            router.defineRoute({
              path: '/accepted',
              handler: ({ res }) => {
                res.setStatus(202)
                return json({ queued: true }, { headers: { 'x-queue': 'a' } })
              },
            })
          },
          async ({ fetch }) => {
            const created = await fetch('/created', { method: 'POST' })
            expect(created.status).toBe(201)
            expect(created.headers.get('location')).toBe('/items/1')
            expect(created.headers.getSetCookie()).toEqual([
              'session=abc; Path=/; HttpOnly',
              'theme=dark; Path=/',
            ])

            const accepted = await fetch('/accepted')
            expect(accepted.status).toBe(202)
            expect(accepted.headers.get('x-queue')).toBe('a')
            expect(await accepted.json()).toEqual({ queued: true })
          }
        ))

      it('answers 204 without body when the handler returns nothing', () =>
        withApp(
          (router) => {
            router.defineRoute({
              method: 'delete',
              path: '/items/:id',
              handler: () => {},
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/items/1', { method: 'DELETE' })
            expect(res.status).toBe(204)
            expect(res.headers.get('content-type')).toBeNull()
            expect(await res.text()).toBe('')
          }
        ))

      it('does not add framework headers', () =>
        withApp(
          (router) => {
            router.defineRoute({ path: '/plain', handler: () => 'ok' })
          },
          async ({ fetch }) => {
            const res = await fetch('/plain')
            expect(res.headers.get('x-powered-by')).toBeNull()
            expect(res.headers.get('etag')).toBeNull()
          }
        ))

      it('sends redirects', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/old',
              handler: () => redirect('/new'),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/old', { redirect: 'manual' })
            expect(res.status).toBe(302)
            expect(res.headers.get('location')).toBe('/new')
          }
        ))

      it('sends text responses', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/page',
              handler: () =>
                text('<h1>Héllo</h1>', {
                  headers: { 'content-type': 'text/html; charset=utf-8' },
                }),
            })
            router.defineRoute({ path: '/health', handler: () => text('OK') })
          },
          async ({ fetch }) => {
            const page = await fetch('/page')
            expect(page.headers.get('content-type')).toBe(
              'text/html; charset=utf-8'
            )
            expect(await page.text()).toBe('<h1>Héllo</h1>')

            const health = await fetch('/health')
            expect(health.headers.get('content-type')).toBe(
              'text/plain; charset=utf-8'
            )
            expect(await health.text()).toBe('OK')
          }
        ))

      it('sends files without altering their bytes', () => {
        const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)

        return withApp(
          (router) => {
            router.defineRoute({
              path: '/download',
              handler: () =>
                file(bytes, {
                  filename: 'rapport été.bin',
                  contentType: 'application/octet-stream',
                }),
            })
            router.defineRoute({
              path: '/blob',
              handler: () =>
                file(new Blob([bytes], { type: 'image/png' }), {
                  disposition: 'inline',
                }),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/download')
            expect(res.headers.get('content-length')).toBe('256')
            expect(res.headers.get('content-disposition')).toBe(
              `attachment; filename="rapport _t_.bin"; filename*=UTF-8''rapport%20%C3%A9t%C3%A9.bin`
            )
            expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)

            const blob = await fetch('/blob')
            expect(blob.headers.get('content-type')).toBe('image/png')
            expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes)
          }
        )
      })
    })

    describe('streaming', () => {
      it('streams chunks', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/export.csv',
              handler: () =>
                stream(
                  async function* () {
                    yield 'id,name\n'
                    yield new TextEncoder().encode('1,Ada\n')
                  },
                  { contentType: 'text/csv' }
                ),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/export.csv')
            expect(res.status).toBe(200)
            expect(res.headers.get('content-type')).toBe('text/csv')
            expect(await res.text()).toBe('id,name\n1,Ada\n')
          }
        ))

      it('flushes Server-Sent Events as they are produced', () => {
        const released = deferred()

        return withApp(
          (router) => {
            router.defineRoute({
              path: '/events',
              handler: () =>
                sse(
                  async function* ({ signal }) {
                    try {
                      yield { event: 'ready', data: { ok: true } }
                      await waitForAbort(signal)
                    } finally {
                      released.resolve()
                    }
                  },
                  { heartbeat: false }
                ),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/events')
            expect(res.headers.get('content-type')).toBe(
              'text/event-stream; charset=utf-8'
            )
            expect(res.headers.get('cache-control')).toBe('no-cache')

            const reader = res.body!.getReader()
            // The source is still running: the event must not be buffered.
            expect(await within(readChunk(reader), 'first event')).toBe(
              'event: ready\ndata: {"ok":true}\n\n'
            )

            await reader.cancel()
            await within(released.promise, 'source release on disconnect')
          }
        )
      })

      it('cancels the response stream when the client disconnects', () => {
        const cancelled = deferred()

        return withApp(
          (router) => {
            router.defineRoute({
              path: '/download',
              handler: () =>
                file(
                  new ReadableStream<Uint8Array>({
                    pull: (controller) =>
                      controller.enqueue(new Uint8Array(64 * 1024)),
                    cancel: () => cancelled.resolve(),
                  })
                ),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/download')
            const reader = res.body!.getReader()
            await reader.read()
            await reader.cancel()

            await within(cancelled.promise, 'response stream cancel')
          }
        )
      })

      it('aborts req.signal when the client disconnects', () => {
        const started = deferred()
        const aborted = deferred()

        return withApp(
          (router) => {
            router.defineRoute({
              path: '/slow',
              handler: async ({ req }) => {
                started.resolve()
                await waitForAbort(req.signal)
                aborted.resolve()
                return { late: true }
              },
            })
          },
          async ({ fetch }) => {
            const controller = new AbortController()
            const pending = fetch('/slow', { signal: controller.signal }).catch(
              () => undefined
            )

            await within(started.promise, 'handler start')
            controller.abort()

            await within(aborted.promise, 'req.signal abort')
            await pending
          }
        )
      })

      it('aborts the connection when a stream fails', () =>
        withApp(
          (router) => {
            router.defineRoute({
              path: '/broken',
              handler: () =>
                stream(async function* () {
                  yield 'partial'
                  throw new Error('Source failed')
                }),
            })
          },
          async ({ fetch }) => {
            const res = await fetch('/broken')
            expect(res.status).toBe(200)
            const outcome = await within(
              res.text().then(
                () => 'completed',
                () => 'aborted'
              ),
              'body read'
            )
            // A cleanly ended response would hide the failure from the client.
            expect(outcome).toBe('aborted')
          }
        ))
    })
  })
}
