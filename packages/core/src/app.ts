import type {
  CompiledRoute,
  DotpressRuntime,
  HttpAdapter,
  RouteInfo,
} from './adapter.js'
import type { Middleware, ResponseFilter } from './context.js'
import type { NormalizedRequest } from './http.js'
import { createConsoleLogger, type Logger } from './logger.js'
import { routeKey } from './path.js'
import {
  compileRoute,
  createRuntime,
  type ErrorHook,
  type PipelineConfig,
} from './pipeline.js'
import { globalRouter, type Router } from './routes.js'

export interface AppOptions<TAdapter extends HttpAdapter = HttpAdapter> {
  /** HTTP adapter (Express, Hono, Fastify…). */
  adapter: TAdapter
  /**
   * Routers to mount. Defaults to the global router (routes declared with
   * `defineRoute()` and filters registered with `registerResponseFilter()`).
   */
  routers?: Router[]
  /** Global middlewares, run before group and route middlewares. */
  middlewares?: Middleware[]
  /** Filters applied to every successful JSON result, before router filters. */
  responseFilters?: ResponseFilter[]
  /** Defaults to a `console` based logger. Pino loggers are supported. */
  logger?: Logger
  /**
   * Includes the message and stack of unexpected errors in 500 responses.
   * Never enable it in production. Defaults to `false`.
   */
  exposeErrors?: boolean
  /** Defaults to `crypto.randomUUID()`. */
  generateRequestId?: (request: NormalizedRequest) => string
  /** Called with unexpected errors, for instance to report them to Sentry. */
  onError?: ErrorHook
}

type NativeOf<TAdapter> =
  TAdapter extends HttpAdapter<infer TNative> ? TNative : unknown

export interface App<TNative = unknown> {
  readonly adapter: HttpAdapter<TNative>
  readonly logger: Logger
  /** Mounted routes (introspection). */
  readonly routes: readonly RouteInfo[]
  /** Native server instance of the adapter. */
  native(): TNative
  /** Starts the server. Not available on serverless adapters. */
  listen(port: number, host?: string): Promise<void>
  close(): Promise<void>
}

const compileRouters = (
  routers: readonly Router[],
  config: PipelineConfig
): CompiledRoute[] => {
  const compiled: CompiledRoute[] = []
  const seen = new Map<string, string>()

  for (const router of routers) {
    const filters = router.getResponseFilters()

    for (const route of router.getRoutes()) {
      const key = routeKey(route.method, route.path)
      const existing = seen.get(key)

      if (existing !== undefined) {
        throw new Error(
          `Route conflict: "${route.method.toUpperCase()} ${route.path}" is already defined as "${existing}".`
        )
      }

      seen.set(key, `${route.method.toUpperCase()} ${route.path}`)
      compiled.push(compileRoute(route, filters, config))
    }
  }

  return compiled
}

/**
 * Creates a Dotpress application and mounts its routes on the adapter.
 */
export const createApp = async <TAdapter extends HttpAdapter<unknown>>(
  options: AppOptions<TAdapter>
): Promise<App<NativeOf<TAdapter>>> => {
  const { adapter } = options

  if (!adapter || typeof adapter.mount !== 'function') {
    throw new TypeError('createApp() requires an HTTP adapter.')
  }

  const logger = options.logger ?? createConsoleLogger()

  const config: PipelineConfig = Object.freeze({
    logger,
    exposeErrors: options.exposeErrors ?? false,
    generateRequestId: options.generateRequestId ?? (() => crypto.randomUUID()),
    onError: options.onError,
    middlewares: [...(options.middlewares ?? [])],
    responseFilters: [...(options.responseFilters ?? [])],
  })

  const routers = options.routers ?? [globalRouter]
  const routes = compileRouters(routers, config)
  const runtime: DotpressRuntime = createRuntime(config)

  await adapter.mount(routes, runtime)

  const typedAdapter = adapter as HttpAdapter<NativeOf<TAdapter>>

  return Object.freeze({
    adapter: typedAdapter,
    logger,
    routes: Object.freeze(routes.map((route) => route.definition)),
    native: () => typedAdapter.native(),
    listen: async (port: number, host?: string) => {
      if (!adapter.listen) {
        throw new Error(
          `The "${adapter.name}" adapter does not support listen().`
        )
      }
      await adapter.listen(port, host)
    },
    close: async () => {
      await adapter.close?.()
    },
  })
}
