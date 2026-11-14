import { createAuth, type KeyPairOptions } from '@dotpress/auth'
import type { Store } from './store.ts'

// Type of ctx.user: what dataProvider.findUserById() returns.
declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
    username: string
    roles: string[]
  }
}

export interface AuthOptions {
  keys: KeyPairOptions
  store: Store
  /** `iss` claim of the tokens: the URL of the API, per environment. */
  issuer: string
  /** bcrypt cost. Defaults to 12 (about 200 ms per login). */
  passwordHashRounds?: number
}

export const createAuthService = ({
  keys,
  store,
  issuer,
  passwordHashRounds,
}: AuthOptions) =>
  createAuth({
    keys,
    issuer,
    dataProvider: store.dataProvider,
    ...(passwordHashRounds !== undefined && { passwordHashRounds }),
    // Clients choose at login: { mode: 'cookie' } for browsers (both tokens
    // in httpOnly cookies, out of reach of the JavaScript of the page), the
    // body otherwise (mobile apps, other services).
    cookies: { enabled: true, accessTokenInCookie: true },
  })
