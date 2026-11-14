import {
  createApp,
  type App,
  type AppOptions,
  type HttpAdapter,
  type NormalizedResponse,
} from '@dotpress/core'
import {
  DEFAULT_BODY_LIMIT,
  createRouteMatcher,
  fromWebRequest,
  readRequestBody,
  toWebResponse,
  type CompiledRoute,
  type DotpressRuntime,
  type RouteMatcher,
} from '@dotpress/core/adapter'
import { createMemoryLogger, type MemoryLogger } from './logger.js'
import { toRequest } from './request.js'

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

    const normalized = fromWebRequest(request, {
      ip: options.ip ?? '127.0.0.1',
    })

    const match = matcher.match(request.method, normalized.path)
    if (!match) {
      await request.body?.cancel()
      return runtime.handleNotFound(normalized)
    }

    try {
      const { body, files, rawBody } = await readRequestBody(
        request,
        match.route.definition.bodyLimit ?? bodyLimit
      )
      normalized.body = body
      normalized.files = files
      normalized.rawBody = rawBody
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
    fetch: async (path, init) => adapter.fetch(await toRequest(path, init)),
    close: () => app.close(),
  }
}
