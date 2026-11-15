import {
  HttpError,
  type HttpAdapter,
  type NormalizedRequest,
  type NormalizedResponse,
} from '@dotpress/core'
import {
  DEFAULT_BODY_LIMIT,
  createRouteMatcher,
  fromWebRequest,
  parseRequestBody,
  payloadTooLargeError,
  readRequestBody,
  toWebResponse,
  type CompiledRoute,
  type DotpressRuntime,
  type RequestBody,
  type RouteMatch,
} from '@dotpress/core/adapter'
import { Hono, type Context } from 'hono'
import { assertKnownOptions } from './options.js'

/**
 * Minimal shape of a Hono application (Hono 4 or 5). The types of Hono 5
 * differ from those of Hono 4, hence the loose signatures.
 */
export interface HonoApplication {
  use: (...args: never[]) => unknown
  notFound: (...args: never[]) => unknown
  onError: (...args: never[]) => unknown
  fetch: (
    request: Request,
    env?: never,
    executionContext?: never
  ) => Response | Promise<Response>
}

/** Members of the Hono application used by the adapter. */
interface MountableApp {
  use(
    path: string,
    handler: (c: Context, next: () => Promise<void>) => Promise<Response | void>
  ): unknown
  notFound(handler: (c: Context) => Promise<Response>): unknown
  onError(handler: (error: Error, c: Context) => Promise<Response>): unknown
  fetch(
    request: Request,
    env?: unknown,
    executionContext?: unknown
  ): Response | Promise<Response>
}

export interface HonoAdapterOptions<TApp extends HonoApplication = Hono> {
  /** Hono application to mount the routes on. Defaults to `new Hono()`. */
  app?: TApp
  /** Registers native middlewares before the Dotpress routes. */
  beforeRoutes?: (app: TApp) => void | Promise<void>
  /**
   * Registers native middlewares and routes after the Dotpress routes,
   * before the not-found handler.
   */
  afterRoutes?: (app: TApp) => void | Promise<void>
  /**
   * Maximum request body size, in bytes. Defaults to 1 MiB. Routes can
   * override it with their own `bodyLimit`.
   */
  bodyLimit?: number
  /**
   * Client IP address of a request (`ctx.req.ip`). Defaults to the address
   * given by the runtime: the socket on Node.js, the source IP of API
   * Gateway, the last `X-Forwarded-For` entry behind an Application Load
   * Balancer (added by the load balancer). Proxy headers are not read
   * otherwise: behind another proxy (CloudFront…), read them here.
   */
  getIp?: (c: Context) => string | undefined
}

export interface HonoAdapter<
  TApp extends HonoApplication = Hono,
> extends HttpAdapter<TApp> {
  /**
   * Handles a Web request, like `app.native().fetch()`: for runtimes that
   * take a `fetch` handler, and for tests.
   */
  fetch(
    request: Request,
    env?: unknown,
    executionContext?: unknown
  ): Promise<Response>
  /** Closes the responses being streamed (their `req.signal` is aborted). */
  close(): Promise<void>
}

/** Environment given by `@hono/node-server` and `@hono/aws-lambda`. */
interface RuntimeEnv {
  readonly incoming?: { readonly socket?: { readonly remoteAddress?: unknown } }
  readonly requestContext?: {
    readonly identity?: { readonly sourceIp?: unknown }
    readonly http?: { readonly sourceIp?: unknown }
    readonly elb?: unknown
  }
}

/**
 * Client address given by the runtime: the socket on Node.js, the source
 * IP of API Gateway (REST and HTTP APIs, Function URLs), or the address
 * appended to `X-Forwarded-For` by an Application Load Balancer.
 */
const runtimeIp = (c: Context): string | undefined => {
  const env = c.env as RuntimeEnv | undefined

  const socket = env?.incoming?.socket?.remoteAddress
  if (typeof socket === 'string') return socket

  const context = env?.requestContext
  const sourceIp = context?.identity?.sourceIp ?? context?.http?.sourceIp
  if (typeof sourceIp === 'string') return sourceIp

  if (context?.elb !== undefined) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)
    return forwarded?.trim() || undefined
  }
  return undefined
}

/** Code and default message of client errors. */
const CLIENT_ERRORS: Record<number, readonly [string, string]> = {
  400: ['BAD_REQUEST', 'Bad Request'],
  401: ['UNAUTHORIZED', 'Unauthorized'],
  403: ['FORBIDDEN', 'Forbidden'],
  404: ['NOT_FOUND', 'Not Found'],
  405: ['METHOD_NOT_ALLOWED', 'Method Not Allowed'],
  408: ['REQUEST_TIMEOUT', 'Request Timeout'],
  409: ['CONFLICT', 'Conflict'],
  413: ['PAYLOAD_TOO_LARGE', 'Payload Too Large'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported Media Type'],
  422: ['UNPROCESSABLE_ENTITY', 'Unprocessable Entity'],
  429: ['TOO_MANY_REQUESTS', 'Too Many Requests'],
}

interface HttpExceptionLike {
  readonly status: number
  readonly message: string
  readonly res?: Response
  getResponse(): Response
}

/** `HTTPException` of Hono 4 or 5, recognized by its shape. */
const isHttpException = (error: unknown): error is HttpExceptionLike =>
  error instanceof Error &&
  typeof (error as Partial<HttpExceptionLike>).status === 'number' &&
  typeof (error as Partial<HttpExceptionLike>).getResponse === 'function'

/**
 * Converts the client errors (4xx) raised by native middlewares
 * (`HTTPException`) into Dotpress errors, with the same status. Anything
 * else is an unexpected error.
 */
const fromNativeError = (error: unknown): unknown => {
  if (!isHttpException(error)) return error

  const { status, message } = error
  if (!Number.isInteger(status) || status < 400 || status > 499) return error

  const [code, defaultMessage] = CLIENT_ERRORS[status] ?? [
    'CLIENT_ERROR',
    'Client Error',
  ]
  return new HttpError(status, code, message || defaultMessage, {
    cause: error,
  })
}

/**
 * Adds the headers of the custom response of an `HTTPException`
 * (`WWW-Authenticate`…) to the Dotpress error response.
 */
const addNativeHeaders = (
  response: NormalizedResponse,
  error: HttpExceptionLike
) => {
  if (!error.res) return
  for (const [name, value] of error.res.headers) {
    if (name.startsWith('content-')) continue
    if (name === 'set-cookie') continue
    response.headers[name] = value
  }
  const cookies = error.res.headers.getSetCookie()
  if (cookies.length > 0) {
    const current = response.headers['set-cookie'] ?? []
    response.headers['set-cookie'] = [
      ...(Array.isArray(current) ? current : [current]),
      ...cookies,
    ]
  }
}

const encoder = new TextEncoder()

/**
 * Body already read by a native middleware, from the cache of Hono
 * (`c.req.json()`, `c.req.parseBody()`…). Only an `ArrayBuffer` or a
 * `Blob` keeps the exact bytes (`rawBody`).
 */
const cachedBody = async (c: Context, limit: number): Promise<RequestBody> => {
  const cache = c.req.bodyCache as Partial<
    Record<'arrayBuffer' | 'blob' | 'text' | 'formData', Promise<unknown>>
  >
  const contentType = c.req.header('content-type')

  let bytes: Uint8Array
  let exact = false
  let type = contentType

  if (cache.arrayBuffer) {
    bytes = new Uint8Array((await cache.arrayBuffer) as ArrayBuffer)
    exact = true
  } else if (cache.blob) {
    bytes = new Uint8Array(await ((await cache.blob) as Blob).arrayBuffer())
    exact = true
  } else if (cache.text) {
    bytes = encoder.encode((await cache.text) as string)
  } else if (cache.formData) {
    // Serialized again, with a new boundary.
    const response = new Response((await cache.formData) as FormData)
    bytes = new Uint8Array(await response.arrayBuffer())
    type = response.headers.get('content-type') ?? undefined
  } else {
    throw new Error(
      'The request body was read by a native middleware outside the cache of Hono (c.req.raw): read it with c.req.json(), c.req.text() or c.req.arrayBuffer().'
    )
  }

  if (bytes.byteLength > limit) throw payloadTooLargeError()
  const parsed = await parseRequestBody(bytes, type)
  return { ...parsed, rawBody: exact ? bytes : undefined }
}

// Reading the body through Hono consumes the request.
const readBody = (c: Context, limit: number): Promise<RequestBody> =>
  c.req.raw.bodyUsed ? cachedBody(c, limit) : readRequestBody(c.req.raw, limit)

/**
 * Closes the streamed body when the adapter is closed, and aborts the
 * request signal when the client cancels it.
 */
const track = (
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  streams: Set<() => void>
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  let stop: () => void = () => {}

  return new ReadableStream<Uint8Array>({
    start() {
      // The cancelled reader ends the stream (see `pull()`).
      stop = () => {
        streams.delete(stop)
        controller.abort()
        reader.cancel().catch(() => {})
      }
      streams.add(stop)
    },
    async pull(stream) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          streams.delete(stop)
          stream.close()
        } else {
          stream.enqueue(value)
        }
      } catch (error) {
        streams.delete(stop)
        stream.error(error)
      }
    },
    cancel(reason) {
      streams.delete(stop)
      controller.abort(reason)
      return reader.cancel(reason)
    },
  })
}

/**
 * Creates the Hono adapter. The main entry is runtime-agnostic: serve
 * `adapter.fetch` with the runtime, or use `honoAdapter()` of
 * `@dotpress/adapter-hono/node` to listen on Node.js.
 *
 * @example
 * const adapter = honoAdapter()
 * await createApp({ adapter })
 * export default { fetch: adapter.fetch }
 */
export function honoAdapter(options?: HonoAdapterOptions<Hono>): HonoAdapter
export function honoAdapter<TApp extends HonoApplication>(
  options: HonoAdapterOptions<TApp> & { app: TApp }
): HonoAdapter<TApp>
export function honoAdapter<TApp extends HonoApplication>(
  options: HonoAdapterOptions<TApp> = {}
): HonoAdapter<TApp> {
  assertKnownOptions('honoAdapter()', options, [
    'app',
    'beforeRoutes',
    'afterRoutes',
    'bodyLimit',
    'getIp',
  ] satisfies (keyof HonoAdapterOptions<TApp>)[])
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT

  if (!Number.isInteger(bodyLimit) || bodyLimit < 0) {
    throw new RangeError(
      'honoAdapter(): bodyLimit must be a non-negative integer (bytes).'
    )
  }

  const application = options.app ?? (new Hono() as unknown as TApp)
  const app = application as unknown as MountableApp
  const getIp = options.getIp ?? runtimeIp
  let mounted = false
  /** Closes the responses being streamed, so that `close()` can complete. */
  const streams = new Set<() => void>()

  const normalize = (c: Context, signal?: AbortSignal): NormalizedRequest =>
    fromWebRequest(c.req.raw, { ip: getIp(c), signal, raw: c })

  const send = (
    c: Context,
    response: NormalizedResponse,
    controller?: AbortController
  ): Promise<Response> => {
    const { body } = response
    if (controller && body instanceof ReadableStream) {
      return toWebResponse(
        { ...response, body: track(body, controller, streams) },
        c.req.method
      )
    }
    return toWebResponse(response, c.req.method)
  }

  const handleRoute = async (
    c: Context,
    match: RouteMatch,
    runtime: DotpressRuntime
  ): Promise<Response> => {
    const controller = new AbortController()
    const signal = AbortSignal.any([c.req.raw.signal, controller.signal])
    const request = normalize(c, signal)

    try {
      const { body, files, rawBody } = await readBody(
        c,
        match.route.definition.bodyLimit ?? bodyLimit
      )
      request.body = body
      request.files = files
      request.rawBody = rawBody
    } catch (error) {
      return send(c, await runtime.handleError(error, request))
    }

    request.params = match.params
    return send(c, await match.route.execute(request), controller)
  }

  return {
    name: 'hono',

    mount: async (
      routes: readonly CompiledRoute[],
      runtime: DotpressRuntime
    ) => {
      if (mounted) throw new Error('The Hono adapter is already mounted.')
      mounted = true

      const matcher = createRouteMatcher(routes)

      await options.beforeRoutes?.(application)

      app.use('*', async (c, next) => {
        const match = matcher.match(c.req.method, new URL(c.req.url).pathname)
        if (!match) {
          await next()
          return
        }
        return handleRoute(c, match, runtime)
      })

      await options.afterRoutes?.(application)

      app.notFound(async (c) =>
        send(c, await runtime.handleNotFound(normalize(c)))
      )

      app.onError(async (error, c) => {
        const converted = fromNativeError(error)
        const response = await runtime.handleError(converted, normalize(c))
        if (converted !== error) {
          addNativeHeaders(response, error as unknown as HttpExceptionLike)
        }
        return send(c, response)
      })
    },

    fetch: async (request, env, executionContext) =>
      app.fetch(request, env, executionContext),

    close: async () => {
      for (const stop of [...streams]) stop()
    },

    native: () => application,
  }
}
