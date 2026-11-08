import {
  defineMiddleware,
  forbiddenError,
  unauthorizedError,
} from '@dotpress/core'
import type { AuthSession, AuthUser } from './types.js'

/** Context guaranteed by `requireAuth` and `requireRole()`. */
export interface AuthenticatedContext {
  user: AuthUser
  auth: AuthSession
}

/**
 * Requires an authenticated user (`401 UNAUTHORIZED` otherwise). In the
 * handlers of the routes using it, `ctx.user` and `ctx.auth` are defined.
 */
export const requireAuth = defineMiddleware<AuthenticatedContext>((ctx) =>
  ctx.user && ctx.auth ? undefined : unauthorizedError()
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
  })
}
