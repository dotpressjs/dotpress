import type { RouteInfo } from './adapter.js'
import type {
  Middleware,
  MiddlewareResult,
  RequestContext,
  ResponseFilter,
} from './context.js'
import type { NormalizedRequest, NormalizedResponse } from './http.js'
import type { Logger } from './logger.js'
import type { ErrorHook } from './pipeline.js'
import type { RouteGroup } from './routes.js'

/**
 * Plugin installed with `createApp({ plugins })`.
 */
export interface Plugin {
  /** Unique name, used by `dependsOn` and `getPlugin()`. */
  readonly name: string
  /** Plugins that must be installed, and set up, before this one. */
  readonly dependsOn?: readonly string[]
  /** Registers the plugin features. Called once, in dependency order. */
  setup(api: PluginAPI): void | Promise<void>
}

/**
 * Declares a plugin. Extra properties are allowed, and exposed to other
 * plugins through `api.getPlugin()`.
 *
 * @example
 * export const healthPlugin = (path = '/health') =>
 *   definePlugin({
 *     name: 'health',
 *     setup(api) {
 *       api.addRoute({ path, handler: () => ({ status: 'ok' }) })
 *     },
 *   })
 */
export const definePlugin = <const T extends Plugin>(plugin: T): T => plugin

/**
 * Hook run for every request matching a route, before the middlewares.
 * Returning an error or a response stops the pipeline, like a middleware.
 */
export type RequestHook = (
  ctx: RequestContext
) => MiddlewareResult | Promise<MiddlewareResult>

export interface ResponseEvent {
  readonly request: NormalizedRequest
  readonly response: NormalizedResponse
  readonly requestId: string
  /** Undefined for requests that matched no route. */
  readonly ctx: RequestContext | undefined
  /** Undefined for requests that matched no route. */
  readonly route: RouteInfo | undefined
  /**
   * Time spent producing the response, in milliseconds. Streamed bodies are
   * not included.
   */
  readonly duration: number
}

/**
 * Hook run for every response produced by Dotpress, including `404`,
 * `405` and adapter errors. It may return a new response to replace it.
 */
export type ResponseHook = (
  event: ResponseEvent
) => void | NormalizedResponse | Promise<void | NormalizedResponse>

export type LifecycleHook = () => void | Promise<void>

/** Context keys provided by the core, which plugins cannot decorate. */
export type BaseContextKey =
  'req' | 'res' | 'requestId' | 'logger' | 'raw' | 'publicPath'

export type DecoratableContextKey = Exclude<
  keyof RequestContext,
  BaseContextKey
>

/**
 * Computes the value of a decorated context key. Called on first access,
 * at most once per request.
 */
export type ContextFactory<K extends DecoratableContextKey> = (
  ctx: RequestContext
) => RequestContext[K]

export interface PluginHooks {
  /** After every plugin is set up and the routes are compiled. */
  onInit(hook: LifecycleHook): void
  /** After the routes are mounted on the adapter, before `listen()`. */
  onReady(hook: LifecycleHook): void
  onRequest(hook: RequestHook): void
  onResponse(hook: ResponseHook): void
  /** When `app.close()` is called, after the server is stopped. */
  onClose(hook: LifecycleHook): void
}

/**
 * API given to `Plugin.setup()`. Registration methods are only available
 * during `setup()`.
 */
export interface PluginAPI {
  /** Name of the plugin being set up. */
  readonly name: string
  /** Logger bound to the plugin (`plugin` field). */
  readonly logger: Logger
  /**
   * Prefix of every route (`basePath` option), normalized. Empty when the
   * app has no base path.
   */
  readonly basePath: string
  /**
   * Prefix removed by the reverse proxy (`publicBasePath` option),
   * normalized. Empty when not configured.
   */
  readonly publicBasePath: string
  /**
   * Path seen by the browser for a route path, for instance for a cookie
   * `Path` or a documentation URL.
   *
   * @example api.publicPath('/auth') // '/my-app/api/auth'
   */
  publicPath(path: string): string
  addRoute: RouteGroup['defineRoute']
  addRouteGroup: RouteGroup['createGroup']
  /**
   * Middleware run for every route, after the request hooks and before the
   * middlewares given to `createApp()`.
   */
  addGlobalMiddleware(middleware: Middleware): void
  /** Filter applied to every successful JSON result. */
  addResponseFilter(filter: ResponseFilter): void
  /**
   * Provides a context key, declared on `RequestContext` through module
   * augmentation. The factory runs on first access, once per request.
   *
   * @example
   * declare module '@dotpress/core' {
   *   interface RequestContext {
   *     mailer: Mailer
   *   }
   * }
   * api.decorateContext('mailer', () => mailer)
   */
  decorateContext<K extends DecoratableContextKey>(
    key: K,
    factory: ContextFactory<K>
  ): void
  /** Called with unexpected errors, like the `onError` option. */
  onError(hook: ErrorHook): void
  readonly hooks: PluginHooks
  /** Mounted routes. Available from the `onInit` hook. */
  getRoutes(): readonly RouteInfo[]
  /** Another installed plugin, for instance to read its public settings. */
  getPlugin<T extends Plugin = Plugin>(name: string): T | undefined
  /** Installed plugins, in setup order (dependencies first). */
  getPlugins(): readonly Plugin[]
}

const BASE_CONTEXT_KEYS: ReadonlySet<string> = new Set<BaseContextKey>([
  'req',
  'res',
  'requestId',
  'logger',
  'raw',
  'publicPath',
])

export const isBaseContextKey = (key: string) => BASE_CONTEXT_KEYS.has(key)

const declaredContextKeys = new Map<string, string>()

/**
 * Declares a context key provided by a plugin, so that accessing it
 * without the plugin installed throws an explicit error instead of
 * returning `undefined`. Call it next to the module augmentation, at the
 * top level of the package.
 *
 * @example
 * declare module '@dotpress/core' {
 *   interface RequestContext {
 *     mailer: Mailer
 *   }
 * }
 * declareContextKey('mailer', 'mailerPlugin')
 */
export const declareContextKey = (
  key: DecoratableContextKey,
  pluginName: string
): void => {
  if (isBaseContextKey(key)) {
    throw new TypeError(`"${key}" is a reserved context key.`)
  }
  declaredContextKeys.set(key, pluginName)
}

export const getDeclaredContextKeys = (): ReadonlyMap<string, string> =>
  declaredContextKeys

/**
 * Sorts plugins so that dependencies are set up first, keeping the given
 * order otherwise.
 */
export const sortPlugins = (plugins: readonly Plugin[]): Plugin[] => {
  const byName = new Map<string, Plugin>()

  for (const plugin of plugins) {
    if (
      typeof plugin !== 'object' ||
      plugin === null ||
      typeof plugin.name !== 'string' ||
      typeof plugin.setup !== 'function'
    ) {
      throw new TypeError(
        'Invalid plugin: expected an object with a name and a setup() function (see definePlugin()).'
      )
    }
    if (byName.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is installed twice.`)
    }
    byName.set(plugin.name, plugin)
  }

  const sorted: Plugin[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (plugin: Plugin, path: string[]) => {
    const current = state.get(plugin.name)
    if (current === 'done') return
    if (current === 'visiting') {
      throw new Error(
        `Circular plugin dependency: ${[...path, plugin.name].join(' -> ')}.`
      )
    }

    state.set(plugin.name, 'visiting')
    for (const dependency of plugin.dependsOn ?? []) {
      const required = byName.get(dependency)
      if (!required) {
        throw new Error(
          `Plugin "${plugin.name}" depends on "${dependency}", which is not installed.`
        )
      }
      visit(required, [...path, plugin.name])
    }
    state.set(plugin.name, 'done')
    sorted.push(plugin)
  }

  for (const plugin of plugins) visit(plugin, [])
  return sorted
}
