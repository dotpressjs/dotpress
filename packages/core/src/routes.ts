import type { Middleware, ResponseFilter, RouteHandler } from './context.js'
import { isHttpMethod, type HttpMethod } from './http.js'
import {
  joinPaths,
  normalizePath,
  type EmptyObject,
  type PathParams,
  type Simplify,
} from './path.js'
import type { RouteSchema, SchemaDefinition } from './schema.js'

/**
 * Documentation metadata of a route (used by `@dotpress/openapi`).
 */
export interface RouteMeta {
  summary?: string
  description?: string
  tags?: string[]
  operationId?: string
  deprecated?: boolean
  /** Security schemes required by the route. */
  security?: string[]
  /** Excludes the route from generated documentation. */
  hidden?: boolean
}

/**
 * Route definition.
 *
 * Declare `schema` before `handler`, so that the handler context is typed
 * from the schema.
 */
export interface RouteConfig<
  P extends string,
  S extends RouteSchema,
  TParentParams = EmptyObject,
  TRawBody extends boolean = false,
> {
  /** Defaults to `get`. */
  method?: HttpMethod
  path: P
  schema?: SchemaDefinition<S>
  /** Route middlewares, run after global and group middlewares. */
  middlewares?: Middleware[]
  /**
   * Keeps the raw bytes of the request body in `req.rawBody`, in addition
   * to the parsed body. Use it to verify webhook signatures.
   */
  rawBody?: TRawBody
  /**
   * Maximum request body size in bytes, for instance to accept uploads.
   * Defaults to the adapter limit (1 MiB unless configured otherwise).
   */
  bodyLimit?: number
  handler: RouteHandler<S, Simplify<TParentParams & PathParams<P>>, TRawBody>
  meta?: RouteMeta
  /** Success status. Defaults to 200 (204 when nothing is returned). */
  status?: number
}

/**
 * Route stored in a router, with the group prefix and middlewares applied.
 */
export interface RouteRecord {
  readonly method: HttpMethod
  readonly path: string
  readonly schema: SchemaDefinition<RouteSchema> | undefined
  readonly middlewares: readonly Middleware[]
  readonly handler: RouteHandler<RouteSchema, Record<string, string>>
  readonly meta: RouteMeta
  readonly status: number | undefined
  readonly rawBody: boolean
  readonly bodyLimit: number | undefined
}

export interface RouteGroup<TParams = EmptyObject> {
  readonly prefix: string
  defineRoute<
    const P extends string,
    S extends RouteSchema = EmptyObject,
    TRawBody extends boolean = false,
  >(
    route: RouteConfig<P, S, TParams, TRawBody>
  ): void
  /** Creates a nested group, inheriting the prefix and middlewares. */
  createGroup<const P extends string>(
    prefix: P,
    middlewares?: Middleware[]
  ): RouteGroup<TParams & PathParams<P>>
}

export interface Router extends RouteGroup {
  /** Registers a filter applied to the JSON results of this router's routes. */
  addResponseFilter(filter: ResponseFilter): void
  getRoutes(): readonly RouteRecord[]
  getResponseFilters(): readonly ResponseFilter[]
  /** Removes all routes and filters. */
  clear(): void
}

const assertStatus = (status: number | undefined, path: string) => {
  if (
    status !== undefined &&
    (!Number.isInteger(status) || status < 100 || status > 599)
  ) {
    throw new RangeError(`Invalid status ${status} for route "${path}".`)
  }
}

/**
 * Creates an isolated route registry.
 */
export const createRouter = (): Router => {
  let routes: RouteRecord[] = []
  let filters: ResponseFilter[] = []

  const register = (
    prefix: string,
    groupMiddlewares: readonly Middleware[],
    route: RouteConfig<string, RouteSchema, unknown, boolean>
  ) => {
    const method = route.method ?? 'get'

    if (!isHttpMethod(method)) {
      throw new TypeError(`Unsupported HTTP method "${String(method)}".`)
    }

    if (typeof route.handler !== 'function') {
      throw new TypeError(`Route "${route.path}" has no handler.`)
    }

    const path = joinPaths(prefix, route.path)
    assertStatus(route.status, path)

    if (route.rawBody !== undefined && typeof route.rawBody !== 'boolean') {
      throw new TypeError(`Invalid rawBody option for route "${path}".`)
    }

    if (
      route.bodyLimit !== undefined &&
      (!Number.isInteger(route.bodyLimit) || route.bodyLimit < 0)
    ) {
      throw new RangeError(
        `Invalid bodyLimit for route "${path}": expected a non-negative integer (bytes).`
      )
    }

    routes.push({
      method,
      path,
      schema: route.schema,
      middlewares: [...groupMiddlewares, ...(route.middlewares ?? [])],
      handler: route.handler as RouteRecord['handler'],
      meta: { ...route.meta },
      status: route.status,
      rawBody: route.rawBody === true,
      bodyLimit: route.bodyLimit,
    })
  }

  const createGroup = (
    prefix: string,
    middlewares: readonly Middleware[]
  ): RouteGroup<never> => ({
    prefix,
    defineRoute: (route) =>
      register(
        prefix,
        middlewares,
        route as unknown as RouteConfig<string, RouteSchema, unknown, boolean>
      ),
    createGroup: (subPrefix, subMiddlewares = []) =>
      createGroup(joinPaths(prefix, normalizePath(subPrefix)), [
        ...middlewares,
        ...subMiddlewares,
      ]),
  })

  const root = createGroup('', [])

  return {
    prefix: '',
    defineRoute: root.defineRoute,
    createGroup: (prefix, middlewares = []) =>
      createGroup(normalizePath(prefix), middlewares),
    addResponseFilter: (filter) => {
      filters.push(filter)
    },
    getRoutes: () => [...routes],
    getResponseFilters: () => [...filters],
    clear: () => {
      routes = []
      filters = []
    },
  } as Router
}

/**
 * Router used by `defineRoute()`, `createRouteGroup()` and
 * `registerResponseFilter()`. `createApp()` uses it when no `routers` option
 * is given.
 */
export const globalRouter: Router = createRouter()

/**
 * Declares a route on the global router.
 */
export const defineRoute: Router['defineRoute'] = (route) =>
  globalRouter.defineRoute(route)

/**
 * Creates a route group on the global router.
 */
export const createRouteGroup: Router['createGroup'] = (prefix, middlewares) =>
  globalRouter.createGroup(prefix, middlewares)

/**
 * Registers a response filter on the global router.
 */
export const registerResponseFilter = (filter: ResponseFilter): void =>
  globalRouter.addResponseFilter(filter)
