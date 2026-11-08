import {
  DEFAULT_BODY_LIMIT,
  createApp,
  createRouteMatcher,
  parseQueryString,
  parseRequestBody,
  payloadTooLargeError,
  unsupportedMediaTypeError,
  type App,
  type AppOptions,
  type CompiledRoute,
  type DotpressRuntime,
  type HttpAdapter,
  type IncomingHeaders,
  type NormalizedRequest,
  type NormalizedResponse,
  type RouteMatcher,
} from '@dotpress/core'
import { createMemoryLogger, type MemoryLogger } from './logger.js'

export interface MemoryAdapterOptions {
  /** Maximum request body size, in bytes. Defaults to 1 MiB. */
  bodyLimit?: number
  /** Client IP address given to requests. Defaults to `127.0.0.1`. */
  ip?: string
}

export interface MemoryAdapter extends HttpAdapter<{
  readonly routes: readonly CompiledRoute[]
}> {
  /** Handles a Web `Request` in memory, without opening a port. */
  fetch(request: Request): Promise<Response>
}

interface BodyResult {
  readonly bytes: Uint8Array
}

const readBody = async (
  request: Request,
  limit: number
): Promise<BodyResult | undefined> => {
  if (request.body === null) return undefined

  const encoding = (request.headers.get('content-encoding') ?? 'identity')
    .trim()
    .toLowerCase()
  if (encoding !== 'identity') {
    await request.body.cancel()
    throw unsupportedMediaTypeError(
      `Unsupported content encoding "${encoding}"`
    )
  }

  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await request.body.cancel()
    throw payloadTooLargeError()
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw payloadTooLargeError()
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes }
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

const toWebResponse = async (
  response: NormalizedResponse,
  method: string
): Promise<Response> => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item)
    }
  }

  let body = response.body
  if (method === 'HEAD' || NULL_BODY_STATUSES.has(response.status)) {
    if (body instanceof ReadableStream) await body.cancel().catch(() => {})
    body = null
  }

  return new Response(body as BodyInit | null, {
    status: response.status,
    headers,
  })
}

const normalizeHeaders = (headers: Headers): IncomingHeaders => {
  const result: IncomingHeaders = {}
  for (const [name, value] of headers) result[name.toLowerCase()] = value
  return result
}

/**
 * HTTP adapter running requests in memory, for tests. It follows the
 * adapter contract like any other adapter, and passes the conformance
 * suite.
 */
export const memoryAdapter = (
  options: MemoryAdapterOptions = {}
): MemoryAdapter => {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT
  let routes: readonly CompiledRoute[] = []
  let matcher: RouteMatcher | undefined
  let runtime: DotpressRuntime | undefined

  const handle = async (request: Request): Promise<NormalizedResponse> => {
    if (!matcher || !runtime) {
      throw new Error('The memory adapter is not mounted: call createApp().')
    }

    const url = new URL(request.url)
    const normalized: NormalizedRequest = {
      method: request.method,
      path: url.pathname,
      url: request.url,
      params: {},
      query: parseQueryString(url.search),
      headers: normalizeHeaders(request.headers),
      body: undefined,
      signal: request.signal,
      ip: options.ip ?? '127.0.0.1',
      raw: request,
    }

    const match = matcher.match(request.method, url.pathname)
    if (!match) {
      await request.body?.cancel()
      return runtime.handleNotFound(normalized)
    }

    try {
      const read = await readBody(
        request,
        match.route.definition.bodyLimit ?? bodyLimit
      )
      if (read) {
        const parsed = await parseRequestBody(
          read.bytes,
          request.headers.get('content-type') ?? undefined
        )
        normalized.body = parsed.body
        normalized.files = parsed.files
        normalized.rawBody = read.bytes
      }
    } catch (error) {
      return runtime.handleError(error, normalized)
    }

    normalized.params = match.params
    return match.route.execute(normalized)
  }

  return {
    name: 'memory',
    mount(compiledRoutes, dotpressRuntime) {
      if (runtime) throw new Error('The memory adapter is already mounted.')
      routes = compiledRoutes
      matcher = createRouteMatcher(compiledRoutes)
      runtime = dotpressRuntime
    },
    native: () => ({ routes }),
    async fetch(request) {
      return toWebResponse(await handle(request), request.method)
    },
  }
}

export interface TestAppOptions extends Omit<AppOptions, 'adapter' | 'logger'> {
  /** Options of the memory adapter. */
  adapter?: MemoryAdapterOptions
  /** Defaults to a new memory logger. */
  logger?: MemoryLogger
}

export interface TestApp {
  readonly app: App<{ readonly routes: readonly CompiledRoute[] }>
  readonly adapter: MemoryAdapter
  /** Logger of the app, recording the log entries. */
  readonly logger: MemoryLogger
  /**
   * Sends a request to the app, like `fetch()`. `path` is relative to
   * `http://localhost`.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>
  close(): Promise<void>
}

/**
 * Creates an app on the memory adapter.
 *
 * @example
 * const { fetch } = await createTestApp({ routers: [router], plugins: [authPlugin(auth)] })
 * const res = await fetch('/auth/me', { headers: { authorization: `Bearer ${token}` } })
 * expect(res.status).toBe(200)
 */
export const createTestApp = async (
  options: TestAppOptions = {}
): Promise<TestApp> => {
  const { adapter: adapterOptions, ...appOptions } = options
  const logger = appOptions.logger ?? createMemoryLogger()
  const adapter = memoryAdapter(adapterOptions)
  const app = await createApp({ ...appOptions, logger, adapter })

  return {
    app,
    adapter,
    logger,
    fetch: (path, init) =>
      adapter.fetch(new Request(new URL(path, 'http://localhost'), init)),
    close: () => app.close(),
  }
}
