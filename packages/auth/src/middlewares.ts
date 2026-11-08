import {
  defineMiddleware,
  forbiddenError,
  unauthorizedError,
} from '@dotpress/core'
import type { AuthSession, AuthUser } from './types.js'

/** Documents the routes using the guards as secured by an access token. */
const SECURED = { security: ['bearerAuth'] }

/** Context guaranteed by `requireAuth`, `requireRole()` and `requireClient()`. */
export interface AuthenticatedContext {
  user: AuthUser
  auth: AuthSession
}

/**
 * Requires an authenticated user (`401 UNAUTHORIZED` otherwise). In the
 * handlers of the routes using it, `ctx.user` and `ctx.auth` are defined.
 */
export const requireAuth = defineMiddleware<AuthenticatedContext>(
  (ctx) => (ctx.user && ctx.auth ? undefined : unauthorizedError()),
  SECURED
)

/**
 * Requires an authenticated user with at least one of the roles
 * (`401 UNAUTHORIZED` without user, `403 FORBIDDEN` without role). Roles
 * come from the `getUserRoles` setting of `createAuth()`.
 */
export const requireRole = (...roles: [string, ...string[]]) => {
  if (roles.length === 0) {
    throw new TypeError('requireRole() expects at least one role.')
  }

  return defineMiddleware<AuthenticatedContext>((ctx) => {
    if (!ctx.user || !ctx.auth) return unauthorizedError()
    const granted = ctx.auth.roles
    return roles.some((role) => granted.includes(role))
      ? undefined
      : forbiddenError()
  }, SECURED)
}

/**
 * Requires an access token issued for one of the clients (`401
 * UNAUTHORIZED` without user, `403 FORBIDDEN` for another client). For
 * example, keeps the tokens of a mobile app away from the backoffice
 * routes. It does not prove which application sends the request: combine
 * it with `requireRole()`.
 */
export const requireClient = (...clientIds: [string, ...string[]]) => {
  if (clientIds.length === 0) {
    throw new TypeError('requireClient() expects at least one client.')
  }

  return defineMiddleware<AuthenticatedContext>((ctx) => {
    if (!ctx.user || !ctx.auth) return unauthorizedError()
    const { clientId } = ctx.auth
    return clientId !== undefined && clientIds.includes(clientId)
      ? undefined
      : forbiddenError()
  }, SECURED)
}
