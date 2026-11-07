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
  /** Response for requests matching no route. Never rejects. */
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
