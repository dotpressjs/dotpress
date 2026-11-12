import { createAuth, type KeyPairSettings } from '@dotpress/auth'
import type { Database } from '../db/database.ts'
import type { User, UserRepository } from '../users/repository.ts'
import { createDataProvider } from './data-provider.ts'

// Type of ctx.user: what dataProvider.findUserById() returns.
declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
    email: string
    name: string
    locale: User['locale']
    createdAt: string
  }
}

export interface AuthOptions {
  db: Database
  users: UserRepository
  keys: KeyPairSettings
  /** `iss` claim: the public URL of the API. */
  issuer: string
  /** bcrypt cost. Defaults to 12 (about 200 ms per login). */
  passwordHashRounds?: number | undefined
}

/** The authentication service: tokens in the body, refresh token rotation. */
export const createAuthService = ({
  db,
  users,
  keys,
  issuer,
  passwordHashRounds,
}: AuthOptions) =>
  createAuth({
    keys,
    issuer,
    dataProvider: createDataProvider(db, users),
    ...(passwordHashRounds !== undefined && { passwordHashRounds }),
  })
