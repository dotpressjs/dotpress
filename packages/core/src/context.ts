import type { HttpError } from './errors.js'
import type { QueryValues, UploadedFiles } from './http.js'
import type { Logger } from './logger.js'
import type { EmptyObject } from './path.js'
import type { DotpressRequest } from './request.js'
import type { DotpressResponse } from './response.js'
import type { JsonResult, RawResult, ResponseResult } from './results.js'
import type { SchemaInput, SchemaOutput } from './schema.js'

/**
 * Context received by middlewares and handlers.
 *
 * Plugins and applications extend it through module augmentation:
 *
 * @example
 * declare module '@dotpress/core' {
 *   interface RequestContext {
 *     tenant?: Tenant
 *   }
 * }
 */
export interface RequestContext {
  req: DotpressRequest
  res: DotpressResponse
  /** Unique identifier of the request, also sent as `X-Request-ID`. */
  requestId: string
  /** Logger bound to the request (`requestId` field). */
  logger: Logger
  /** Native request object of the adapter (escape hatch). */
  raw: unknown
}

/**
 * Value a middleware may return. Returning an error or a response stops the
 * pipeline; returning nothing continues it.
 */
export type MiddlewareResult = void | undefined | HttpError | ResponseResult

/**
 * Middlewares run before request validation: `ctx.req` holds raw values.
 *
 * `TProvides` lists the context properties a middleware guarantees to the
 * handlers of the routes and groups using it (see `defineMiddleware()`).
 */
export interface Middleware<TProvides = unknown> {
  (ctx: RequestContext): MiddlewareResult | Promise<MiddlewareResult>
  /** Type-only marker, never set at runtime. */
  readonly '~provides'?: TProvides
}

/**
 * Declares a middleware that guarantees context properties to handlers.
 *
 * @example
 * const requireTenant = defineMiddleware<{ tenant: Tenant }>((ctx) =>
 *   ctx.tenant ? undefined : forbiddenError()
 * )
 *
 * defineRoute({
 *   path: '/settings',
 *   middlewares: [requireTenant],
 *   handler: ({ tenant }) => tenant.settings, // Tenant, not Tenant | undefined
 * })
 */
export const defineMiddleware = <TProvides = unknown>(
  middleware: (
    ctx: RequestContext
  ) => MiddlewareResult | Promise<MiddlewareResult>
): Middleware<TProvides> => middleware as Middleware<TProvides>

type UnionToIntersection<U> = (
  U extends unknown ? (value: U) => void : never
) extends (value: infer I) => void
  ? I
  : never

/**
 * List of middlewares, typed with the context properties each one provides.
 * Inferring the provided types per element keeps inline middlewares
 * (`(ctx) => …`) and typed middlewares usable in the same list.
 */
export type MiddlewareList<TProvided extends readonly unknown[]> = {
  readonly [K in keyof TProvided]: Middleware<TProvided[K]>
}

/**
 * Context properties guaranteed by a list of middlewares (see
 * `MiddlewareList`).
 */
export type ProvidedContext<TProvided extends readonly unknown[]> =
  UnionToIntersection<
    {
      [K in keyof TProvided]: unknown extends TProvided[K]
        ? never
        : TProvided[K]
    }[number]
  >

/**
 * Transforms successful JSON results before serialization.
 */
export type ResponseFilter = (
  ctx: RequestContext,
  result: unknown
) => unknown | Promise<unknown>

/**
 * Request typed from the route schema. With `rawBody: true`, `rawBody` is
 * always defined.
 */
export type RouteRequest<S, TPathParams, TRawBody = false> = DotpressRequest<
  SchemaOutput<S, 'params', TPathParams>,
  SchemaOutput<S, 'query', QueryValues>,
  SchemaOutput<S, 'body', unknown>,
  SchemaOutput<S, 'files', UploadedFiles>
> &
  (TRawBody extends true ? { readonly rawBody: Uint8Array } : EmptyObject)

/**
 * Context received by a route handler.
 */
export type HandlerContext<
  S,
  TPathParams,
  TRawBody = false,
  TProvided = unknown,
> = Omit<RequestContext, 'req'> &
  TProvided & {
    req: RouteRequest<S, TPathParams, TRawBody>
  }

/**
 * Value a handler may return. With a `response` schema, plain values and
 * `json()` data must match the schema input type.
 */
export type HandlerResult<S> = S extends { response: unknown }
  ? | SchemaInput<S, 'response', unknown>
    | JsonResult<SchemaInput<S, 'response', unknown>>
    | RawResult
    | HttpError
    | undefined
  : unknown

export type RouteHandler<
  S,
  TPathParams,
  TRawBody = false,
  TProvided = unknown,
> = (
  ctx: HandlerContext<S, TPathParams, TRawBody, TProvided>
) => HandlerResult<S> | Promise<HandlerResult<S>>
