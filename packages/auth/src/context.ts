import { declareContextKey } from '@dotpress/core'
import type { AuthSession, AuthUser } from './types.js'

declare module '@dotpress/core' {
  interface RequestContext {
    /** Authenticated user (`authPlugin`). Use `requireAuth` to require it. */
    user: AuthUser | undefined
    /** Access token data of the authenticated user (`authPlugin`). */
    auth: AuthSession | undefined
  }
}

// Accessing these keys without `authPlugin` throws an explicit error.
declareContextKey('user', 'authPlugin')
declareContextKey('auth', 'authPlugin')
