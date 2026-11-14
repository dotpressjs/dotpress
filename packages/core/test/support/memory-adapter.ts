import {
  createApp,
  createRouter,
  type AppOptions,
  type HttpAdapter,
  type NormalizedRequest,
  type NormalizedResponse,
  type Router,
} from '../../src/index.js'
import {
  createRouteMatcher,
  malformedBodyError,
  parseQueryString,
  parseRequestBody,
  type CompiledRoute,
  type DotpressRuntime,
} from '../../src/adapter-api.js'

export interface InjectOptions {
  method?: string
  url: string
  headers?: Record<string, string | string[]>
  /** Already parsed body. */
  body?: unknown
  /** Raw JSON body, parsed by the adapter. */
  rawBody?: string
  /** Multipart body, encoded then parsed by the adapter. */
  formData?: FormData
  /** Simulates client disconnections. */
  signal?: AbortSignal
  /** Client IP address. */
  ip?: string
}

export interface InjectResponse {
  status: number
  headers: Record<string, string | string[]>
  /** Parsed JSON body, or the text body. */
  body: unknown
  text: string | undefined
  response: NormalizedResponse
}

export interface MemoryAdapter extends HttpAdapter<{
  routes: readonly CompiledRoute[]
}> {
  /** Runs the request and reads the whole response body. */
  inject(options: InjectOptions): Promise<InjectResponse>
  /** Runs the request without reading the response body. */
  dispatch(options: InjectOptions): Promise<NormalizedResponse>
}

const readBody = async (body: NormalizedResponse['body']) => {
  if (body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  return new Response(body).text()
}

/**
 * Minimal in-memory adapter used to test the core without an HTTP server.
 */
export const memoryAdapter = (): MemoryAdapter => {
  let routes: readonly CompiledRoute[] = []
  let matcher = createRouteMatcher([])
  let runtime: DotpressRuntime | undefined

  const dispatch = async (
    options: InjectOptions
  ): Promise<NormalizedResponse> => {
    if (!runtime) throw new Error('The adapter is not mounted.')

    const url = new URL(options.url, 'http://localhost')
    const method = (options.method ?? 'GET').toLowerCase()

    const query = parseQueryString(url.search)

    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers[name.toLowerCase()] = value
    }

    const request: NormalizedRequest = {
      method,
      path: url.pathname,
      url: url.toString(),
      params: {},
      query,
      headers,
      body: options.body,
      signal: options.signal,
      ip: options.ip,
      raw: { injected: options },
    }

    if (options.rawBody !== undefined) {
      request.rawBody = new TextEncoder().encode(options.rawBody)
      try {
        request.body = JSON.parse(options.rawBody)
      } catch {
        return runtime.handleError(malformedBodyError(), request)
      }
    }

    if (options.formData !== undefined) {
      const encoded = new Request(url, {
        method: 'POST',
        body: options.formData,
      })
      const bytes = new Uint8Array(await encoded.arrayBuffer())
      try {
        const parsed = await parseRequestBody(
          bytes,
          encoded.headers.get('content-type') ?? undefined
        )
        request.body = parsed.body
        request.files = parsed.files
        request.rawBody = bytes
      } catch (error) {
        return runtime.handleError(error, request)
      }
    }

    const match = matcher.match(method, url.pathname)
    if (match) {
      return match.route.execute({ ...request, params: match.params })
    }

    return runtime.handleNotFound(request)
  }

  return {
    name: 'memory',
    mount(compiledRoutes, dotpressRuntime) {
      routes = compiledRoutes
      matcher = createRouteMatcher(compiledRoutes)
      runtime = dotpressRuntime
    },
    native: () => ({ routes }),
    dispatch,
    async inject(options) {
      const response = await dispatch(options)
      const text = await readBody(response.body)
      const contentType = String(response.headers['content-type'] ?? '')

      return {
        status: response.status,
        headers: response.headers,
        body:
          text !== undefined && contentType.startsWith('application/json')
            ? JSON.parse(text)
            : text,
        text,
        response,
      }
    },
  }
}

/**
 * Creates an app on an isolated router with the in-memory adapter.
 */
export const createTestApp = async (
  setup: (router: Router) => void,
  options: Omit<AppOptions, 'adapter' | 'routers'> = {}
) => {
  const router = createRouter()
  setup(router)

  const adapter = memoryAdapter()
  const app = await createApp({
    logger: silentLogger(),
    ...options,
    adapter,
    routers: [router],
  })

  return { app, router, inject: adapter.inject, dispatch: adapter.dispatch }
}

/**
 * Logger that records entries instead of printing them.
 */
export const silentLogger = () => {
  const entries: { level: string; args: unknown[] }[] = []

  const create = (): import('../../src/index.js').Logger => ({
    debug: (...args: unknown[]) => void entries.push({ level: 'debug', args }),
    info: (...args: unknown[]) => void entries.push({ level: 'info', args }),
    warn: (...args: unknown[]) => void entries.push({ level: 'warn', args }),
    error: (...args: unknown[]) => void entries.push({ level: 'error', args }),
    child: () => create(),
  })

  return Object.assign(create(), { entries })
}
