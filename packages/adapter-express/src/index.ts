import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  DEFAULT_BODY_LIMIT,
  HttpError,
  createRouteMatcher,
  isHttpError,
  malformedBodyError,
  parseQueryString,
  parseRequestBody,
  payloadTooLargeError,
  unsupportedMediaTypeError,
  type CompiledRoute,
  type DotpressRuntime,
  type HttpAdapter,
  type NormalizedRequest,
  type NormalizedResponse,
  type RouteMatch,
  type UploadedFiles,
} from '@dotpress/core'
import express, { type Express } from 'express'

/**
 * Minimal shape of an Express application, compatible with Express 4 and 5.
 */
export interface ExpressApplication {
  (req: IncomingMessage, res: ServerResponse): void
  use(...handlers: unknown[]): unknown
}

export interface ExpressAdapterOptions<TApp extends ExpressApplication> {
  /**
   * Express application (Express 4 or 5) to mount the routes on. Defaults to
   * a new application, created with `express()`.
   */
  app?: TApp
  /** Registers native middlewares before the Dotpress routes (helmet…). */
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
}

export interface ExpressAdapter<
  TApp extends ExpressApplication = Express,
> extends HttpAdapter<TApp> {
  /** Starts an HTTP server. */
  listen(port: number, host?: string): Promise<void>
  /**
   * Stops the HTTP server: waits for pending requests, and closes the
   * responses being streamed (their `req.signal` is aborted).
   */
  close(): Promise<void>
  /** HTTP server started by `listen()`, if any. */
  server(): Server | undefined
}

/** Express request fields used by the adapter (Express 4 and 5). */
interface ExpressRequest extends IncomingMessage {
  originalUrl?: string
  protocol?: string
  body?: unknown
  /** Set by body-parser and similar middlewares once the body is read. */
  _body?: boolean
}

type NextFunction = (error?: unknown) => void

/** Rejection reason when the client goes away while the body is read. */
const CLIENT_GONE = Symbol('client gone')

const pathnameOf = (url: string) => {
  const index = url.indexOf('?')
  return index === -1 ? url : url.slice(0, index)
}

const searchOf = (url: string) => {
  const index = url.indexOf('?')
  return index === -1 ? '' : url.slice(index)
}

const fullUrl = (req: ExpressRequest): string | undefined => {
  const host = req.headers.host
  if (!host) return undefined
  const protocol = req.protocol ?? 'http'
  return `${protocol}://${host}${req.originalUrl ?? req.url ?? '/'}`
}

const hasBody = (req: IncomingMessage) =>
  req.headers['transfer-encoding'] !== undefined ||
  (req.headers['content-length'] !== undefined &&
    req.headers['content-length'] !== '0')

/** Discards the rest of the request body. */
const discard = (req: IncomingMessage) => {
  req.resume()
}

interface RequestBody {
  readonly body: unknown
  readonly files: UploadedFiles | undefined
  /** Undefined when a native middleware read the body. */
  readonly rawBody: Uint8Array | undefined
}

const NO_BODY: RequestBody = {
  body: undefined,
  files: undefined,
  rawBody: undefined,
}

const readBody = (req: ExpressRequest, limit: number): Promise<RequestBody> => {
  // The body was already read by a native middleware (express.json(),
  // multer…): use its result.
  if (req._body === true || req.readableEnded) {
    return Promise.resolve({
      body: req.body,
      files: undefined,
      rawBody: undefined,
    })
  }

  if (!hasBody(req)) {
    return Promise.resolve(NO_BODY)
  }

  const encoding = (req.headers['content-encoding'] ?? 'identity')
    .trim()
    .toLowerCase()

  if (encoding !== 'identity') {
    discard(req)
    return Promise.reject(
      unsupportedMediaTypeError(`Unsupported content encoding "${encoding}"`)
    )
  }

  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    discard(req)
    return Promise.reject(payloadTooLargeError())
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onGone)
      req.off('close', onClose)
    }

    function onData(chunk: Buffer) {
      size += chunk.byteLength
      if (size > limit) {
        cleanup()
        discard(req)
        reject(payloadTooLargeError())
        return
      }
      chunks.push(chunk)
    }

    function onEnd() {
      cleanup()
      const buffer = Buffer.concat(chunks, size)
      const bytes = new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength
      )
      parseRequestBody(bytes, req.headers['content-type']).then(
        ({ body, files }) => resolve({ body, files, rawBody: bytes }),
        reject
      )
    }

    function onGone() {
      cleanup()
      reject(CLIENT_GONE)
    }

    function onClose() {
      if (!req.complete) onGone()
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onGone)
    req.on('close', onClose)
  })
}

const ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
}

/**
 * Converts errors raised by native middlewares (`next(error)`) into Dotpress
 * errors. Client errors (4xx) keep their status; anything else is an
 * unexpected error.
 */
const fromNativeError = (error: unknown): unknown => {
  if (isHttpError(error) || typeof error !== 'object' || error === null) {
    return error
  }

  const { type, status, statusCode, expose, message } = error as {
    type?: unknown
    status?: unknown
    statusCode?: unknown
    expose?: unknown
    message?: unknown
  }

  if (type === 'entity.parse.failed') {
    return malformedBodyError()
  }

  const code = typeof status === 'number' ? status : statusCode
  if (typeof code !== 'number' || !Number.isInteger(code)) return error
  if (code < 400 || code > 499) return error

  return new HttpError(
    code,
    ERROR_CODES[code] ?? 'CLIENT_ERROR',
    expose === true && typeof message === 'string' && message
      ? message
      : 'Bad Request',
    undefined,
    { cause: error }
  )
}

const waitForDrain = (res: ServerResponse) =>
  new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })

/**
 * Creates the Express adapter (Express 4 or 5).
 *
 * @example
 * const app = await createApp({
 *   adapter: expressAdapter({
 *     beforeRoutes: (app) => app.use(helmet()),
 *   }),
 * })
 * await app.listen(3000)
 */
export function expressAdapter(
  options?: ExpressAdapterOptions<Express>
): ExpressAdapter<Express>
export function expressAdapter<TApp extends ExpressApplication>(
  options: ExpressAdapterOptions<TApp> & { app: TApp }
): ExpressAdapter<TApp>
export function expressAdapter<TApp extends ExpressApplication>(
  options: ExpressAdapterOptions<TApp> = {}
): ExpressAdapter<TApp> {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT

  if (!Number.isInteger(bodyLimit) || bodyLimit < 0) {
    throw new RangeError(
      'Invalid bodyLimit: expected a non-negative integer (bytes).'
    )
  }

  let app = options.app
  if (!app) {
    const created = express()
    created.disable('x-powered-by')
    created.disable('etag')
    app = created as unknown as TApp
  }

  const application = app
  let mounted = false
  let server: Server | undefined
  /** Aborts the responses being streamed, so that `close()` can complete. */
  const activeStreams = new Set<() => void>()

  const send = async (
    req: IncomingMessage,
    res: ServerResponse,
    response: NormalizedResponse,
    controller?: AbortController
  ): Promise<void> => {
    const { body } = response

    if (res.headersSent || res.destroyed) {
      if (body instanceof ReadableStream) await body.cancel().catch(() => {})
      return
    }

    res.statusCode = response.status
    for (const [name, value] of Object.entries(response.headers)) {
      res.setHeader(name, value)
    }

    if (body === null) {
      res.end()
      return
    }

    if (typeof body === 'string' || body instanceof Uint8Array) {
      if (!res.hasHeader('content-length')) {
        res.setHeader(
          'content-length',
          typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
        )
      }
      res.end(body)
      return
    }

    if (req.method === 'HEAD') {
      await body.cancel().catch(() => {})
      res.end()
      return
    }

    await pipe(body, res, controller)
  }

  const pipe = async (
    body: ReadableStream<Uint8Array>,
    res: ServerResponse,
    controller: AbortController | undefined
  ) => {
    const reader = body.getReader()
    const cancel = () => {
      reader.cancel().catch(() => {})
    }
    const stop = () => {
      controller?.abort()
      cancel()
    }

    res.on('close', cancel)
    activeStreams.add(stop)
    // Sends the headers right away (Server-Sent Events).
    res.flushHeaders()

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || res.destroyed) break

        const writable = res.write(value)
        // Flushes compression middlewares (`compression` adds `res.flush`).
        ;(res as { flush?: () => void }).flush?.()
        if (!writable) await waitForDrain(res)
      }

      if (res.destroyed) cancel()
      else res.end()
    } catch {
      // Ending the response would hide the failure: abort the connection.
      res.destroy()
    } finally {
      res.off('close', cancel)
      activeStreams.delete(stop)
    }
  }

  const normalize = (
    req: ExpressRequest,
    signal?: AbortSignal
  ): NormalizedRequest => {
    const url = req.url ?? '/'
    return {
      method: req.method ?? 'GET',
      path: pathnameOf(url),
      url: fullUrl(req),
      params: {},
      query: parseQueryString(searchOf(url)),
      headers: req.headers,
      body: undefined,
      signal,
      raw: req,
    }
  }

  const fail =
    (res: ServerResponse, runtime: DotpressRuntime) => (error: unknown) => {
      runtime.logger.error(
        error instanceof Error ? error : { error },
        'Express adapter failed to send the response'
      )
      if (!res.headersSent) {
        res.statusCode = 500
        res.end()
      } else {
        res.destroy()
      }
    }

  const handleRoute = async (
    req: ExpressRequest,
    res: ServerResponse,
    match: RouteMatch,
    runtime: DotpressRuntime
  ) => {
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    const request = normalize(req, controller.signal)

    try {
      const { body, files, rawBody } = await readBody(
        req,
        match.route.definition.bodyLimit ?? bodyLimit
      )
      request.body = body
      request.files = files
      request.rawBody = rawBody
    } catch (error) {
      if (error === CLIENT_GONE) return
      await send(req, res, await runtime.handleError(error, request))
      return
    }

    request.params = match.params
    const response = await match.route.execute(request)
    await send(req, res, response, controller)
  }

  return {
    name: 'express',

    mount: async (
      routes: readonly CompiledRoute[],
      runtime: DotpressRuntime
    ) => {
      if (mounted) {
        throw new Error('The Express adapter is already mounted.')
      }
      mounted = true

      const matcher = createRouteMatcher(routes)

      await options.beforeRoutes?.(application)

      application.use(
        (req: ExpressRequest, res: ServerResponse, next: NextFunction) => {
          const match = matcher.match(
            req.method ?? 'GET',
            pathnameOf(req.url ?? '/')
          )
          if (!match) {
            next()
            return
          }
          handleRoute(req, res, match, runtime).catch(fail(res, runtime))
        }
      )

      await options.afterRoutes?.(application)

      application.use((req: ExpressRequest, res: ServerResponse) => {
        runtime
          .handleNotFound(normalize(req))
          .then((response) => send(req, res, response))
          .catch(fail(res, runtime))
      })

      application.use(
        (
          error: unknown,
          req: ExpressRequest,
          res: ServerResponse,
          next: NextFunction
        ) => {
          if (res.headersSent) {
            next(error)
            return
          }
          runtime
            .handleError(fromNativeError(error), normalize(req))
            .then((response) => send(req, res, response))
            .catch(fail(res, runtime))
        }
      )
    },

    listen: async (port: number, host?: string) => {
      if (server) {
        throw new Error('The Express adapter is already listening.')
      }

      const created = createServer(application as RequestListener)
      await new Promise<void>((resolve, reject) => {
        created.once('error', reject)
        created.listen(port, host, () => {
          created.off('error', reject)
          resolve()
        })
      })
      server = created
    },

    close: async () => {
      const current = server
      if (!current) return
      server = undefined

      await new Promise<void>((resolve, reject) => {
        current.close((error) => (error ? reject(error) : resolve()))
        current.closeIdleConnections()
        // Streams never end by themselves: abort them.
        for (const stop of activeStreams) stop()
      })
    },

    native: () => application,
    server: () => server,
  }
}
