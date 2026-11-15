import type {
  Middleware,
  MiddlewareList,
  ProvidedContext,
  ResponseFilter,
  RouteHandler,
} from './context.js'
import { isHttpMethod, type HttpMethod } from './http.js'
import { assertKnownOptions } from './options.js'
import {
  joinPaths,
  normalizePath,
  type EmptyObject,
  type PathParams,
  type Simplify,
} from './path.js'
import type { RouteSchema, Schema, RouteSchemaDefinition } from './schema.js'

/**
 * Documentation metadata of a route (used by `@dotpress/openapi`).
 */
export interface RouteMeta {
  summary?: string
  description?: string
  tags?: readonly string[]
  operationId?: string
  deprecated?: boolean
  /**
   * Security schemes accepted by the route, any of them. Defaults to the
   * schemes declared by its middlewares (`defineMiddleware()`); `[]` marks
   * the route as public.
   */
  security?: readonly string[]
  /** Excludes the route from generated documentation. */
  hidden?: boolean
  /**
   * Other responses of the route, by status: errors returned by the
   * handler, or responses that are not JSON (`file()`, `stream()`,
   * `sse()`, `redirect()`). A description, or a description with a schema
   * or a content type.
   *
   * @example
   * responses: {
   *   404: 'Member not found',
   *   200: { description: 'CSV export', contentType: 'text/csv' },
   * }
   */
  responses?: Record<number, string | DocumentedResponse>
}

/** Documented response of a route (`meta.responses`). */
export interface DocumentedResponse {
  description: string
  /** Body schema. */
  schema?: Schema
  /** Defaults to `application/json`. */
  contentType?: string
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
  TProvided extends readonly unknown[] = unknown[],
  TGroupContext = unknown,
> {
  /** Defaults to `get`. */
  method?: HttpMethod
  path: P
  schema?: RouteSchemaDefinition<S>
  /**
   * Route middlewares, run after global and group middlewares. Context
   * properties they guarantee (`defineMiddleware()`) are typed in the
   * handler.
   */
  middlewares?: MiddlewareList<TProvided>
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
  handler: RouteHandler<
    S,
    Simplify<TParentParams & PathParams<P>>,
    TRawBody,
    TGroupContext & ProvidedContext<TProvided>
  >
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
  readonly schema: RouteSchemaDefinition<RouteSchema> | undefined
  readonly middlewares: readonly Middleware[]
  readonly handler: RouteHandler<RouteSchema, Record<string, string>>
  readonly meta: RouteMeta
  readonly status: number | undefined
  readonly rawBody: boolean
  readonly bodyLimit: number | undefined
}

export interface RouteGroup<TParams = EmptyObject, TContext = unknown> {
  readonly prefix: string
  defineRoute<
    const P extends string,
    S extends RouteSchema = EmptyObject,
    TRawBody extends boolean = false,
    const TProvided extends readonly unknown[] = unknown[],
  >(
    route: RouteConfig<P, S, TParams, TRawBody, TProvided, TContext>
  ): void
  /**
   * Creates a nested group, inheriting the prefix and middlewares. Context
   * properties guaranteed by the group middlewares are typed in the
   * handlers of its routes.
   */
  createGroup<
    const P extends string,
    const TProvided extends readonly unknown[] = unknown[],
  >(
    prefix: P,
    middlewares?: MiddlewareList<TProvided>
  ): RouteGroup<TParams & PathParams<P>, TContext & ProvidedContext<TProvided>>
}

export interface Router extends RouteGroup {
  /** Registers a filter applied to the JSON results of this router's routes. */
  addResponseFilter(filter: ResponseFilter): void
  /** Removes all routes and filters. */
  clear(): void
}

/** Routes and filters of a router: read by `createApp()`. */
interface RouterState {
  readonly routes: readonly RouteRecord[]
  readonly filters: readonly ResponseFilter[]
}

const states = new WeakMap<Router, () => RouterState>()

/**
 * The routes and filters of a router made by `createRouter()`, or
 * `undefined` for any other object.
 */
export const getRouterState = (router: Router): RouterState | undefined =>
  states.get(router)?.()

const ROUTE_OPTIONS: ReadonlySet<string> = new Set([
  'method',
  'path',
  'schema',
  'middlewares',
  'rawBody',
  'bodyLimit',
  'handler',
  'meta',
  'status',
] satisfies (keyof RouteConfig<string, RouteSchema>)[])

const META_OPTIONS: ReadonlySet<string> = new Set([
  'summary',
  'description',
  'tags',
  'operationId',
  'deprecated',
  'security',
  'hidden',
  'responses',
] satisfies (keyof RouteMeta)[])

const RESPONSE_OPTIONS: ReadonlySet<string> = new Set([
  'description',
  'schema',
  'contentType',
] satisfies (keyof DocumentedResponse)[])

const isStatus = (status: number) =>
  Number.isInteger(status) && status >= 100 && status <= 599

const assertStatus = (status: number | undefined, path: string) => {
  if (status !== undefined && !isStatus(status)) {
    throw new RangeError(`Route "${path}": invalid status ${status}.`)
  }
}

const assertResponses = (responses: RouteMeta['responses'], path: string) => {
  if (responses === undefined) return
  for (const [key, response] of Object.entries(responses)) {
    if (!isStatus(Number(key))) {
      throw new RangeError(
        `Route "${path}": invalid status "${key}" in meta.responses.`
      )
    }
    const description =
      typeof response === 'string' ? response : response?.description
    if (typeof description !== 'string') {
      throw new TypeError(
        `Route "${path}": meta.responses[${key}] needs a description.`
      )
    }
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
    route: RouteConfig<string, RouteSchema, unknown, boolean, unknown[]>
  ) => {
    if (typeof route !== 'object' || route === null) {
      throw new TypeError('defineRoute() requires a route object.')
    }
    const label = `Route "${joinPaths(prefix, String(route.path))}"`
    assertKnownOptions(label, route, ROUTE_OPTIONS)
    if (route.meta !== undefined) {
      assertKnownOptions(label, route.meta, META_OPTIONS, 'meta.')
      for (const [status, response] of Object.entries(
        route.meta.responses ?? {}
      )) {
        if (typeof response === 'object' && response !== null) {
          assertKnownOptions(
            label,
            response,
            RESPONSE_OPTIONS,
            `meta.responses.${status}.`
          )
        }
      }
    }

    const method = route.method ?? 'get'

    if (!isHttpMethod(method)) {
      throw new TypeError(`${label}: unsupported method "${String(method)}".`)
    }

    if (typeof route.handler !== 'function') {
      throw new TypeError(`${label}: handler must be a function.`)
    }

    const path = joinPaths(prefix, route.path)
    assertStatus(route.status, path)
    assertResponses(route.meta?.responses, path)

    if (route.rawBody !== undefined && typeof route.rawBody !== 'boolean') {
      throw new TypeError(`${label}: rawBody must be a boolean.`)
    }

    if (
      route.bodyLimit !== undefined &&
      (!Number.isInteger(route.bodyLimit) || route.bodyLimit < 0)
    ) {
      throw new RangeError(
        `${label}: bodyLimit must be a non-negative integer (bytes).`
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
        route as unknown as RouteConfig<
          string,
          RouteSchema,
          unknown,
          boolean,
          unknown[]
        >
      ),
    createGroup: (subPrefix: string, subMiddlewares?: readonly Middleware[]) =>
      createGroup(joinPaths(prefix, normalizePath(subPrefix)), [
        ...middlewares,
        ...(subMiddlewares ?? []),
      ]),
  })

  const root = createGroup('', [])

  const router = {
    prefix: '',
    defineRoute: root.defineRoute,
    createGroup: (prefix: string, middlewares?: readonly Middleware[]) =>
      createGroup(normalizePath(prefix), middlewares ?? []),
    addResponseFilter: (filter) => {
      filters.push(filter)
    },
    clear: () => {
      routes = []
      filters = []
    },
  } as Router
  states.set(router, () => ({ routes: [...routes], filters: [...filters] }))
  return router
}

// The copies of this module loaded in the process, by URL: with two copies
// of @dotpress/core, the routes declared with one are not mounted by the
// other.
const COPIES = Symbol.for('dotpress.core.copies')
const copies = ((globalThis as { [COPIES]?: Set<string> })[COPIES] ??=
  new Set<string>())
copies.add(import.meta.url)

/** The URLs of the copies of `@dotpress/core` loaded in the process. */
export const loadedCopies = (): readonly string[] => [...copies]

/**
 * Router used by `defineRoute()`, `createRouteGroup()` and
 * `addResponseFilter()`. `createApp()` uses it when no `routers` option
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
export const addResponseFilter = (filter: ResponseFilter): void =>
  globalRouter.addResponseFilter(filter)
