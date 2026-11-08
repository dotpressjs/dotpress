import type {
  CompiledRoute,
  DotpressRuntime,
  HttpAdapter,
  RouteInfo,
} from './adapter.js'
import type { Middleware, ResponseFilter } from './context.js'
import type { NormalizedRequest } from './http.js'
import { createConsoleLogger, type Logger } from './logger.js'
import { createRouteMatcher } from './matcher.js'
import { joinPaths, normalizeBasePath, prefixPath, routeKey } from './path.js'
import {
  compileRoute,
  createRuntime,
  type ErrorHook,
  type PipelineConfig,
} from './pipeline.js'
import {
  isBaseContextKey,
  sortPlugins,
  type LifecycleHook,
  type Plugin,
  type PluginAPI,
  type RequestHook,
  type ResponseHook,
} from './plugins.js'
import { createRouter, globalRouter, type Router } from './routes.js'

export interface AppOptions<TAdapter extends HttpAdapter = HttpAdapter> {
  /** HTTP adapter (Express, Hono, Fastify…). */
  adapter: TAdapter
  /**
   * Routers to mount. Defaults to the global router (routes declared with
   * `defineRoute()` and filters registered with `registerResponseFilter()`).
   */
  routers?: Router[]
  /**
   * Plugins, set up in the given order (dependencies first). See
   * `definePlugin()`.
   */
  plugins?: Plugin[]
  /**
   * Global middlewares, run after the plugin middlewares and before group
   * and route middlewares.
   */
  middlewares?: Middleware[]
  /**
   * Filters applied to every successful JSON result, before plugin and
   * router filters.
   */
  responseFilters?: ResponseFilter[]
  /**
   * Prefix of every route, including plugin routes, for an app served under
   * a sub-path by a reverse proxy that forwards the full path (nginx
   * `proxy_pass http://app;`). Requests outside of it get a 404.
   *
   * @example basePath: '/my-app/api' // GET /my-app/api/users
   */
  basePath?: string
  /**
   * Prefix removed by the reverse proxy before forwarding requests (nginx
   * `proxy_pass http://app/;`, Traefik `stripPrefix`). Routes are not
   * prefixed, but paths seen by the browser are (`publicPath()`: cookie
   * paths, documentation URLs, redirects). Cannot be combined with
   * `basePath`.
   */
  publicBasePath?: string
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
  /** Mounted routes (introspection), with the `basePath`. */
  readonly routes: readonly RouteInfo[]
  /** Installed plugins, in setup order (dependencies first). */
  readonly plugins: readonly Plugin[]
  /** Normalized `basePath` option. Empty when not configured. */
  readonly basePath: string
  /** Normalized `publicBasePath` option. Empty when not configured. */
  readonly publicBasePath: string
  /**
   * Path seen by the browser for a route path, with the `basePath` or the
   * `publicBasePath`.
   */
  publicPath(path: string): string
  /** Native server instance of the adapter. */
  native(): TNative
  /** Starts the server. Not available on serverless adapters. */
  listen(port: number, host?: string): Promise<void>
  /** Stops the server, then runs the plugin `onClose` hooks. */
  close(): Promise<void>
}

interface PluginRegistry {
  readonly routers: Router[]
  readonly middlewares: Middleware[]
  readonly responseFilters: ResponseFilter[]
  readonly contextFactories: Map<
    string,
    { plugin: string; factory: (ctx: never) => unknown }
  >
  readonly errorHooks: ErrorHook[]
  readonly requestHooks: RequestHook[]
  readonly responseHooks: ResponseHook[]
  readonly initHooks: LifecycleHook[]
  readonly readyHooks: LifecycleHook[]
  readonly closeHooks: LifecycleHook[]
}

const createPluginRegistry = (): PluginRegistry => ({
  routers: [],
  middlewares: [],
  responseFilters: [],
  contextFactories: new Map(),
  errorHooks: [],
  requestHooks: [],
  responseHooks: [],
  initHooks: [],
  readyHooks: [],
  closeHooks: [],
})

/**
 * Sets up the plugins. Registration methods only work during `setup()`.
 */
interface BasePaths {
  readonly basePath: string
  readonly publicBasePath: string
  readonly publicPath: (path: string) => string
}

const resolveBasePaths = (options: AppOptions): BasePaths => {
  const basePath =
    options.basePath === undefined
      ? ''
      : normalizeBasePath(options.basePath, 'basePath')
  const publicBasePath =
    options.publicBasePath === undefined
      ? ''
      : normalizeBasePath(options.publicBasePath, 'publicBasePath')

  if (options.basePath !== undefined && options.publicBasePath !== undefined) {
    throw new TypeError(
      'basePath and publicBasePath cannot be combined: use basePath when the reverse proxy forwards the full path, publicBasePath when it removes the prefix.'
    )
  }

  const prefix = basePath || publicBasePath
  return {
    basePath,
    publicBasePath,
    publicPath: (path) => prefixPath(prefix, path),
  }
}

const setupPlugins = async (
  plugins: readonly Plugin[],
  logger: Logger,
  getRoutes: () => readonly RouteInfo[],
  paths: BasePaths
): Promise<PluginRegistry & { plugins: readonly Plugin[] }> => {
  const registry = createPluginRegistry()
  const sorted = Object.freeze(sortPlugins(plugins))
  const byName = new Map(sorted.map((plugin) => [plugin.name, plugin]))

  for (const plugin of sorted) {
    let open = true
    const router = createRouter()
    registry.routers.push(router)

    const register =
      <TArgs extends unknown[], TResult>(
        method: string,
        fn: (...args: TArgs) => TResult
      ) =>
      (...args: TArgs): TResult => {
        if (!open) {
          throw new Error(
            `api.${method}() of plugin "${plugin.name}" can only be called during setup().`
          )
        }
        return fn(...args)
      }

    const api: PluginAPI = {
      name: plugin.name,
      logger: logger.child({ plugin: plugin.name }),
      ...paths,
      addRoute: register(
        'addRoute',
        router.defineRoute
      ) as PluginAPI['addRoute'],
      addRouteGroup: register(
        'addRouteGroup',
        router.createGroup
      ) as PluginAPI['addRouteGroup'],
      addGlobalMiddleware: register('addGlobalMiddleware', (middleware) => {
        registry.middlewares.push(middleware)
      }),
      addResponseFilter: register('addResponseFilter', (filter) => {
        registry.responseFilters.push(filter)
      }),
      decorateContext: register(
        'decorateContext',
        (key: string, factory: (ctx: never) => unknown) => {
          if (isBaseContextKey(key)) {
            throw new TypeError(
              `Plugin "${plugin.name}" cannot decorate the reserved context key "${key}".`
            )
          }
          const existing = registry.contextFactories.get(key)
          if (existing) {
            throw new Error(
              `Plugin "${plugin.name}" cannot decorate "ctx.${key}": it is already provided by plugin "${existing.plugin}".`
            )
          }
          if (typeof factory !== 'function') {
            throw new TypeError(
              `decorateContext("${key}") expects a factory function.`
            )
          }
          registry.contextFactories.set(key, { plugin: plugin.name, factory })
        }
      ) as PluginAPI['decorateContext'],
      onError: register('onError', (hook: ErrorHook) => {
        registry.errorHooks.push(hook)
      }),
      hooks: {
        onInit: register('hooks.onInit', (hook: LifecycleHook) => {
          registry.initHooks.push(hook)
        }),
        onReady: register('hooks.onReady', (hook: LifecycleHook) => {
          registry.readyHooks.push(hook)
        }),
        onRequest: register('hooks.onRequest', (hook: RequestHook) => {
          registry.requestHooks.push(hook)
        }),
        onResponse: register('hooks.onResponse', (hook: ResponseHook) => {
          registry.responseHooks.push(hook)
        }),
        onClose: register('hooks.onClose', (hook: LifecycleHook) => {
          registry.closeHooks.push(hook)
        }),
      },
      getRoutes,
      getPlugin: <T extends Plugin = Plugin>(name: string) =>
        byName.get(name) as T | undefined,
      getPlugins: () => sorted,
    }

    try {
      await plugin.setup(api)
    } finally {
      open = false
    }
  }

  return { ...registry, plugins: sorted }
}

/**
 * Calls every error hook; a failing hook is logged and does not prevent
 * the others from running.
 */
const composeErrorHooks = (
  hooks: readonly ErrorHook[],
  logger: Logger
): ErrorHook | undefined =>
  hooks.length === 0
    ? undefined
    : async (error, ctx) => {
        for (const hook of hooks) {
          try {
            await hook(error, ctx)
          } catch (hookError) {
            ;(ctx?.logger ?? logger).error(
              hookError instanceof Error ? hookError : { error: hookError },
              'onError hook failed'
            )
          }
        }
      }

const compileRouters = (
  routers: readonly Router[],
  config: PipelineConfig,
  basePath: string
): CompiledRoute[] => {
  const compiled: CompiledRoute[] = []
  const seen = new Map<string, string>()

  for (const router of routers) {
    const filters = router.getResponseFilters()

    for (const record of router.getRoutes()) {
      const route = basePath
        ? { ...record, path: joinPaths(basePath, record.path) }
        : record
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

  const paths = resolveBasePaths(options)
  const logger = options.logger ?? createConsoleLogger()

  const compiled: { routes?: readonly RouteInfo[] } = {}
  const getRoutes = () => {
    if (!compiled.routes) {
      throw new Error(
        'getRoutes() is available once the routes are compiled: from the onInit hook, or at request time.'
      )
    }
    return compiled.routes
  }

  const registry = await setupPlugins(
    options.plugins ?? [],
    logger,
    getRoutes,
    paths
  )

  const config: PipelineConfig = Object.freeze({
    logger,
    publicPath: paths.publicPath,
    exposeErrors: options.exposeErrors ?? false,
    generateRequestId: options.generateRequestId ?? (() => crypto.randomUUID()),
    onError: composeErrorHooks(
      [...(options.onError ? [options.onError] : []), ...registry.errorHooks],
      logger
    ),
    middlewares: [...registry.middlewares, ...(options.middlewares ?? [])],
    responseFilters: [
      ...(options.responseFilters ?? []),
      ...registry.responseFilters,
    ],
    contextFactories: new Map(
      [...registry.contextFactories].map(([key, { factory }]) => [
        key,
        factory as (ctx: unknown) => unknown,
      ])
    ),
    requestHooks: [...registry.requestHooks],
    responseHooks: [...registry.responseHooks],
  })

  const routers = [...(options.routers ?? [globalRouter]), ...registry.routers]
  const routes = compileRouters(routers, config, paths.basePath)
  const routeInfos = Object.freeze(routes.map((route) => route.definition))
  compiled.routes = routeInfos

  for (const hook of registry.initHooks) await hook()

  const runtime: DotpressRuntime = createRuntime(
    config,
    createRouteMatcher(routes)
  )

  await adapter.mount(routes, runtime)

  for (const hook of registry.readyHooks) await hook()

  const typedAdapter = adapter as HttpAdapter<NativeOf<TAdapter>>

  return Object.freeze({
    adapter: typedAdapter,
    logger,
    routes: routeInfos,
    plugins: registry.plugins,
    ...paths,
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

      // Plugins set up last are closed first.
      let failure: unknown
      for (const hook of [...registry.closeHooks].reverse()) {
        try {
          await hook()
        } catch (error) {
          logger.error(
            error instanceof Error ? error : { error },
            'onClose hook failed'
          )
          failure ??= error
        }
      }
      if (failure !== undefined) throw failure
    },
  })
}
