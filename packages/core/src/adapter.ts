import type {
  HttpMethod,
  NormalizedRequest,
  NormalizedResponse,
} from './http.js'
import type { Logger } from './logger.js'
import type { RouteMeta } from './routes.js'
import type { RouteSchema } from './schema.js'

/**
 * Introspection data of a route (used by documentation generators).
 */
export interface RouteInfo {
  readonly method: HttpMethod
  /** Path in Dotpress syntax (`/users/:id`). */
  readonly path: string
  readonly pathParams: readonly string[]
  /** Resolved schemas. */
  readonly schema: Readonly<RouteSchema>
  readonly meta: Readonly<RouteMeta>
  readonly status: number | undefined
  /** Whether the route needs `NormalizedRequest.rawBody`. */
  readonly rawBody: boolean
  /**
   * Maximum body size of the route, in bytes. When undefined, the adapter
   * limit applies (`DEFAULT_BODY_LIMIT` by default).
   */
  readonly bodyLimit: number | undefined
}

/**
 * Route ready to be mounted by an adapter.
 */
export interface CompiledRoute {
  readonly method: HttpMethod
  /** Path in Dotpress syntax (`/users/:id`), translated by the adapter if needed. */
  readonly path: string
  readonly definition: RouteInfo
  /** Runs the whole pipeline. Never rejects. */
  execute(request: NormalizedRequest): Promise<NormalizedResponse>
}

/**
 * Services the core provides to adapters for requests that do not reach a
 * route.
 */
export interface DotpressRuntime {
  readonly logger: Logger
  /**
   * Response for requests matching no route: `404 NOT_FOUND`, or
   * `405 METHOD_NOT_ALLOWED` with an `Allow` header when the path exists for
   * other methods. Never rejects.
   */
  handleNotFound(request: NormalizedRequest): Promise<NormalizedResponse>
  /**
   * Response for errors raised by the adapter itself, for instance a body
   * that cannot be parsed (see `malformedBodyError()`). Never rejects.
   */
  handleError(
    error: unknown,
    request?: NormalizedRequest
  ): Promise<NormalizedResponse>
}

/**
 * Contract implemented by HTTP adapters (Express, Hono, Fastify…).
 *
 * An adapter translates native requests into `NormalizedRequest`, calls
 * `CompiledRoute.execute()`, and writes the returned `NormalizedResponse`.
 * To behave like every other adapter, it must:
 *
 * - match routes with `createRouteMatcher()`, or follow its rules;
 * - parse the query with `parseQueryString()`, and the body with
 *   `parseRequestBody()` (body, files and raw bytes), limited to the route
 *   `bodyLimit`, else to the adapter limit (`DEFAULT_BODY_LIMIT` by
 *   default), with `PAYLOAD_TOO_LARGE` beyond; reject `Content-Encoding`
 *   other than `identity` (`UNSUPPORTED_MEDIA_TYPE`);
 * - send body errors through `DotpressRuntime.handleError()`, and requests
 *   matching no route through `DotpressRuntime.handleNotFound()`;
 * - provide `NormalizedRequest.signal`, aborted when the client disconnects;
 * - send the headers of streamed responses immediately and flush each
 *   chunk; cancel the body stream when the client disconnects; abort the
 *   connection (instead of ending the response) when the body stream fails;
 * - not send a body for `HEAD` requests.
 *
 * New capabilities are always added as optional members, so that existing
 * adapters keep working.
 */
export interface HttpAdapter<TNative = unknown> {
  readonly name: string
  /** Mounts the compiled routes and the not-found fallback. Called once. */
  mount(
    routes: readonly CompiledRoute[],
    runtime: DotpressRuntime
  ): void | Promise<void>
  /** Starts a long-running server. */
  listen?(port: number, host?: string): Promise<void>
  /** Stops the server. */
  close?(): Promise<void>
  /** Native server instance (escape hatch). */
  native(): TNative
}
