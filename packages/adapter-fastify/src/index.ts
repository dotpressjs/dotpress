import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import type { Readable } from 'node:stream'
import {
  HttpError,
  type HttpAdapter,
  type NormalizedRequest,
  type NormalizedResponse,
  type ListenAddress,
} from '@dotpress/core'
import {
  DEFAULT_BODY_LIMIT,
  parseQueryString,
  readRequestBody,
  type CompiledRoute,
  type DotpressRuntime,
  type RequestBody,
} from '@dotpress/core/adapter'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { assertKnownOptions } from './options.js'

export interface FastifyAdapterOptions<
  TApp extends FastifyInstance = FastifyInstance,
> {
  /** Fastify instance to mount the routes on. Defaults to `Fastify()`. */
  app?: TApp
  /**
   * Registers hooks and plugins applied to the Dotpress routes
   * (`@fastify/helmet`…), and native routes.
   */
  beforeRoutes?: (app: TApp) => void | Promise<void>
  /**
   * Registers hooks, plugins and native routes in an encapsulated context:
   * they do not apply to the Dotpress routes (except plugins wrapped with
   * `fastify-plugin`, which apply to the parent context).
   */
  afterRoutes?: (app: FastifyInstance) => void | Promise<void>
  /**
   * Maximum request body size, in bytes. Defaults to 1 MiB. Routes can
   * override it with their own `bodyLimit`.
   */
  bodyLimit?: number
}

export interface FastifyAdapter<
  TApp extends FastifyInstance = FastifyInstance,
> extends HttpAdapter<TApp> {
  /**
   * Starts the HTTP server (`fastify.listen()`). Without `host`, listens on
   * every interface, like Node.js.
   */
  listen(port: number, host?: string): Promise<ListenAddress>
  /**
   * Closes the Fastify instance (`onClose` hooks of the plugins): waits for
   * pending requests, and closes the responses being streamed (their
   * `req.signal` is aborted).
   */
  close(): Promise<void>
  /** HTTP server started by `listen()`, if any. */
  server(): Server | undefined
}

/** Address of a listening Node.js server. */
const addressOf = (server: Server): ListenAddress => {
  const address = server.address() as AddressInfo
  return { port: address.port, host: address.address }
}

/**
 * Lets `close()` complete as soon as the pending requests are served, and
 * returns the function to call on close. Before Node.js 26, `server.close()`
 * waits for the connections that have sent nothing yet (a browser
 * preconnect…) until `headersTimeout`; and, whatever the version, the
 * connections of the pending requests stay open once served, until
 * `keepAliveTimeout`. Fastify keeps listening during its `preClose` hooks:
 * the connections accepted from then on are destroyed right away.
 */
const trackConnections = (server: Server) => {
  const sockets = new Set<Socket>()
  let closing = false
  server.on('connection', (socket: Socket) => {
    if (closing) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on(
    'request',
    (_request: IncomingMessage, response: ServerResponse) => {
      response.once('finish', () => {
        if (closing) server.closeIdleConnections()
      })
    }
  )
  return () => {
    closing = true
    for (const socket of sockets) {
      if (socket.bytesRead === 0) socket.destroy()
    }
  }
}

/** Rejection reason when the client goes away while the body is read. */
const CLIENT_GONE = Symbol('client gone')

const encoder = new TextEncoder()

/**
 * Web stream of a request body. Cancelling it discards the rest of the body
 * instead of destroying the socket, so that the error response can still
 * be sent.
 */
const toWebStream = (payload: Readable): ReadableStream<Uint8Array> => {
  let cleanup = () => {}
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer | string) => {
        // Streams of `preParsing` hooks may produce strings.
        controller.enqueue(
          typeof chunk === 'string'
            ? encoder.encode(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        )
      }
      const onEnd = () => {
        cleanup()
        controller.close()
      }
      // Also emitted when the client goes away (`ECONNRESET`).
      const onError = () => {
        cleanup()
        controller.error(CLIENT_GONE)
      }
      cleanup = () => {
        payload.off('data', onData)
        payload.off('end', onEnd)
        payload.off('error', onError)
      }
      payload.on('data', onData)
      payload.on('end', onEnd)
      payload.on('error', onError)
    },
    cancel() {
      // Still flowing without listener: the rest is discarded.
      cleanup()
    },
  })
}

/**
 * Reads the body with the rules of the core (`readRequestBody()`), from the
 * payload given by Fastify (after its `preParsing` hooks). Fastify does not
 * read the body of `GET` and `HEAD` requests.
 */
const readBody = (
  request: FastifyRequest,
  limit: number
): Promise<RequestBody> => {
  const payload = request.body as Readable | undefined
  const headers = new Headers()
  for (const name of ['content-type', 'content-encoding', 'content-length']) {
    const value = request.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  return readRequestBody(
    new Request('http://localhost/', {
      method: 'POST',
      headers,
      body: payload ? toWebStream(payload) : null,
      duplex: 'half',
    } as RequestInit),
    limit
  )
}

/** Code of client errors. */
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
 * Converts the client errors (`statusCode` 4xx) raised by Fastify and its
 * plugins into Dotpress errors, with the same status and message. Anything
 * else is an unexpected error.
 */
const fromNativeError = (error: unknown): unknown => {
  if (!(error instanceof Error)) return error

  const { statusCode } = error as { statusCode?: unknown }
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) {
    return error
  }
  if (statusCode < 400 || statusCode > 499) return error

  return new HttpError(
    statusCode,
    ERROR_CODES[statusCode] ?? 'CLIENT_ERROR',
    error.message || 'Bad Request',
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
 * Creates the Fastify adapter (Fastify 5).
 *
 * @example
 * const app = await createApp({
 *   adapter: fastifyAdapter({
 *     beforeRoutes: async (app) => {
 *       await app.register(helmet)
 *     },
 *   }),
 * })
 * await app.listen(3000)
 */
export function fastifyAdapter(
  options?: FastifyAdapterOptions<FastifyInstance>
): FastifyAdapter
export function fastifyAdapter<TApp extends FastifyInstance>(
  options: FastifyAdapterOptions<TApp> & { app: TApp }
): FastifyAdapter<TApp>
export function fastifyAdapter<TApp extends FastifyInstance>(
  options: FastifyAdapterOptions<TApp> = {}
): FastifyAdapter<TApp> {
  assertKnownOptions('fastifyAdapter()', options, [
    'app',
    'beforeRoutes',
    'afterRoutes',
    'bodyLimit',
  ] satisfies (keyof FastifyAdapterOptions<TApp>)[])
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT

  if (!Number.isInteger(bodyLimit) || bodyLimit < 0) {
    throw new RangeError(
      'fastifyAdapter(): bodyLimit must be a non-negative integer (bytes).'
    )
  }

  const application = options.app ?? (Fastify() as unknown as TApp)
  let mounted = false
  let listening = false
  let closeConnections = () => {}
  /** Closes the responses being streamed, so that `close()` can complete. */
  const streams = new Set<() => void>()

  const normalize = (
    request: FastifyRequest,
    signal?: AbortSignal
  ): NormalizedRequest => {
    const url = request.url
    const index = url.indexOf('?')
    return {
      method: request.method,
      path: index === -1 ? url : url.slice(0, index),
      url: `${request.protocol}://${request.host}${url}`,
      params: {},
      query: parseQueryString(index === -1 ? '' : url.slice(index)),
      headers: request.headers,
      body: undefined,
      signal,
      ip: request.ip,
      raw: request,
    }
  }

  const send = (
    reply: FastifyReply,
    response: NormalizedResponse,
    controller?: AbortController
  ): FastifyReply | Promise<void> => {
    const { body } = response
    if (body instanceof ReadableStream) {
      return sendStream(reply, response, body, controller)
    }

    reply.code(response.status)
    for (const [name, value] of Object.entries(response.headers)) {
      reply.header(name, value)
    }
    if (body === null) return reply.send()
    if (typeof body === 'string') return reply.send(body)
    return reply.send(
      Buffer.from(body.buffer, body.byteOffset, body.byteLength)
    )
  }

  /**
   * Streams the body with the response of Node.js: Fastify only sends the
   * headers with the first chunk, too late for Server-Sent Events and for
   * streams that fail right away. `onSend` hooks do not apply.
   */
  const sendStream = async (
    reply: FastifyReply,
    response: NormalizedResponse,
    body: ReadableStream<Uint8Array>,
    controller: AbortController | undefined
  ): Promise<void> => {
    reply.hijack()
    const res = reply.raw

    res.statusCode = response.status
    // Headers set by hooks (`@fastify/helmet`…), then by Dotpress.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) res.setHeader(name, value)
    }
    for (const [name, value] of Object.entries(response.headers)) {
      res.setHeader(name, value)
    }

    if (reply.request.method === 'HEAD') {
      await body.cancel().catch(() => {})
      res.end()
      return
    }

    const reader = body.getReader()
    const cancel = () => {
      reader.cancel().catch(() => {})
    }
    const stop = () => {
      controller?.abort()
      cancel()
    }

    res.on('close', cancel)
    streams.add(stop)
    res.flushHeaders()

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(value)) await waitForDrain(res)
      }

      // The reader is cancelled when the client goes away.
      res.end()
    } catch {
      // Ending the response would hide the failure: abort the connection.
      res.destroy()
    } finally {
      res.off('close', cancel)
      streams.delete(stop)
    }
  }

  const handleRoute = async (
    route: CompiledRoute,
    request: FastifyRequest,
    reply: FastifyReply,
    runtime: DotpressRuntime
  ) => {
    const controller = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort()
    })

    const normalized = normalize(request, controller.signal)

    try {
      const { body, files, rawBody } = await readBody(
        request,
        route.definition.bodyLimit ?? bodyLimit
      )
      normalized.body = body
      normalized.files = files
      normalized.rawBody = rawBody
    } catch (error) {
      if (error === CLIENT_GONE) return reply.hijack()
      return send(reply, await runtime.handleError(error, normalized))
    }

    normalized.params = { ...(request.params as Record<string, string>) }
    return send(reply, await route.execute(normalized), controller)
  }

  return {
    name: 'fastify',

    mount: async (
      routes: readonly CompiledRoute[],
      runtime: DotpressRuntime
    ) => {
      if (mounted) throw new Error('The Fastify adapter is already mounted.')
      mounted = true

      const app = application as unknown as FastifyInstance

      // Set first: encapsulated plugins inherit them when they are created.
      app.setNotFoundHandler(async (request, reply) =>
        send(reply, await runtime.handleNotFound(normalize(request)))
      )
      app.setErrorHandler(async (error, request, reply) =>
        send(
          reply,
          await runtime.handleError(fromNativeError(error), normalize(request))
        )
      )

      await options.beforeRoutes?.(application)

      await app.register(async (child) => {
        // Dotpress reads the bodies: the payload is passed as is.
        child.removeAllContentTypeParsers()
        child.addContentTypeParser('*', (_request, payload, done) => {
          done(null, payload)
        })

        // Explicit HEAD routes first: GET routes add one otherwise.
        const ordered = [...routes].sort(
          (a, b) => Number(b.method === 'head') - Number(a.method === 'head')
        )
        for (const route of ordered) {
          const method = route.method.toUpperCase() as 'GET'
          const register = (url: string) => {
            child.route({
              method,
              url,
              exposeHeadRoute: true,
              handler: (request, reply) =>
                handleRoute(route, request, reply, runtime),
            })
          }

          register(route.path)
          // Trailing slashes are ignored, whatever the router options
          // (`findRoute()` follows `ignoreTrailingSlash`).
          if (
            route.path !== '/' &&
            child.findRoute({ method, url: `${route.path}/` }) === null
          ) {
            register(`${route.path}/`)
          }
        }
      })

      // Root hooks apply to every route, whatever the order: only an
      // encapsulated context keeps them away from the Dotpress routes.
      const { afterRoutes } = options
      if (afterRoutes) {
        await app.register(async (scope) => {
          await afterRoutes(scope)
        })
      }
      await app.ready()
    },

    listen: async (port: number, host?: string) => {
      if (listening) {
        throw new Error('The Fastify adapter is already listening.')
      }
      const app = application as unknown as FastifyInstance
      try {
        await app.listen({ port, host: host ?? '::' })
      } catch (error) {
        // No IPv6: every IPv4 interface, like Node.js.
        const code = (error as { code?: unknown }).code
        if (host !== undefined || code !== 'EAFNOSUPPORT') throw error
        await app.listen({ port, host: '0.0.0.0' })
      }
      listening = true
      closeConnections = trackConnections(app.server as Server)
      return addressOf(app.server as Server)
    },

    close: async () => {
      // Streams never end by themselves: close them.
      for (const stop of [...streams]) stop()
      listening = false
      closeConnections()
      await (application as unknown as FastifyInstance).close()
    },

    native: () => application,
    server: () =>
      listening
        ? ((application as unknown as FastifyInstance).server as Server)
        : undefined,
  }
}
