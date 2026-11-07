import type { HttpError } from './errors.js'
import type { QueryValues } from './http.js'
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
 */
export type Middleware = (
  ctx: RequestContext
) => MiddlewareResult | Promise<MiddlewareResult>

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
  SchemaOutput<S, 'body', unknown>
> &
  (TRawBody extends true ? { readonly rawBody: Uint8Array } : EmptyObject)

/**
 * Context received by a route handler.
 */
export type HandlerContext<S, TPathParams, TRawBody = false> = Omit<
  RequestContext,
  'req'
> & {
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

export type RouteHandler<S, TPathParams, TRawBody = false> = (
  ctx: HandlerContext<S, TPathParams, TRawBody>
) => HandlerResult<S> | Promise<HandlerResult<S>>
