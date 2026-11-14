import { createRouter, type AppOptions, type Router } from '@dotpress/core'
import { createTestApp } from '@dotpress/testing'
import bcrypt from 'bcryptjs'
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from 'jose'
import { internalsOf, type AuthInternals } from '../src/auth.js'
import { sha256, toHex } from '../src/crypto.js'
import type { AuthInitOptions } from '../src/types.js'
import {
  authPlugin,
  createAuth,
  type AuthPluginOptions,
  type Auth,
  type AuthOptions,
  type DataProvider,
  type TokenSubject,
  type RefreshTokenData,
} from '../src/index.js'

/** The resolved settings of an auth service (internal). */
export const settingsOf = (auth: Auth): AuthInternals['settings'] =>
  internalsOf(auth)!.settings

/** Imports the keys of an auth service, like `authPlugin()` at startup. */
export const initAuth = (auth: Auth, options?: AuthInitOptions) =>
  internalsOf(auth)!.init(options)

/**
 * An access token of a new session, with its `jti`, issued by
 * `generateTokensForUser()`.
 */
export const issueAccessToken = async (auth: Auth, subject: TokenSubject) => {
  const { accessToken, accessTokenExpiresAt } =
    await auth.generateTokensForUser(subject)
  return {
    accessToken,
    accessTokenId: decodeJwt(accessToken).jti as string,
    expiresAt: accessTokenExpiresAt,
  }
}

/** A refresh token and its hash, like those of the service. */
export const newRefreshToken = async () => {
  const token = toHex(crypto.getRandomValues(new Uint8Array(128)))
  return { token, tokenHash: await sha256(token) }
}

declare module '../src/index.js' {
  interface AuthUser {
    id: string
    username: string
    roles: string[]
  }
}

export const keys = await (async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  return {
    privateKey: await exportPKCS8(pair.privateKey),
    publicKey: await exportSPKI(pair.publicKey),
  }
})()

/** bcrypt cost of the test users, and of the dummy hash. */
/** Default cookie names, with the default (secure) attributes. */
export const ACCESS_COOKIE = '__Host-dotpress_access_token'
export const REFRESH_COOKIE = '__Secure-dotpress_refresh_token'

export const TEST_HASH_ROUNDS = 4

interface StoredUser {
  id: string
  username: string
  passwordHash: string | null
  role: string
  roles: string[]
}

/**
 * In-memory data provider with three users: ada (admin), linus (user), and
 * margaret (user without password, like an SSO account).
 */
export const createStore = (options: { sessionRevocation?: boolean } = {}) => {
  // Low cost factor: fast tests (see TEST_HASH_ROUNDS).
  const passwordHash = bcrypt.hashSync('secret', TEST_HASH_ROUNDS)
  const users = new Map<string, StoredUser>(
    [
      { id: 'u1', username: 'ada', role: 'admin', roles: ['admin'] },
      { id: 'u2', username: 'linus', role: 'user', roles: ['user'] },
    ]
      .map((user): StoredUser => ({ ...user, passwordHash }))
      .concat({
        id: 'u3',
        username: 'margaret',
        role: 'user',
        roles: ['user'],
        passwordHash: null,
      })
      .map((user) => [user.id, user])
  )
  const refreshTokens = new Map<string, RefreshTokenData>()

  const provider: DataProvider = {
    storeRefreshToken: async ({
      tokenHash,
      userId,
      accessTokenId,
      sessionId,
      expiresAt,
    }) => {
      refreshTokens.set(tokenHash, {
        userId,
        accessTokenId,
        sessionId,
        expiresAt,
        isUsed: false,
        usedAt: null,
        revokedAt: null,
      })
    },
    findRefreshToken: async (tokenHash) => refreshTokens.get(tokenHash),
    markRefreshTokenAsUsed: async (tokenHash, usedAt) => {
      const token = refreshTokens.get(tokenHash)
      if (token) {
        token.isUsed = true
        token.usedAt = usedAt
      }
    },
    revokeUserTokens: async (userId) => {
      for (const token of refreshTokens.values()) {
        if (token.userId === userId) token.revokedAt = new Date()
      }
    },
    revokeSessionTokens: async (sessionId) => {
      for (const token of refreshTokens.values()) {
        if (token.sessionId === sessionId) token.revokedAt = new Date()
      }
    },
    // Like a query on the refresh token table: a revoked session has
    // revoked tokens.
    ...(options.sessionRevocation && {
      isSessionRevoked: async (sessionId: string) =>
        [...refreshTokens.values()].some(
          (token) => token.sessionId === sessionId && token.revokedAt
        ),
    }),
    updatePasswordHash: async (userId, hash) => {
      const user = users.get(userId)
      if (user) user.passwordHash = hash
    },
    findUserById: async (userId) => {
      const user = users.get(userId)
      return user && { id: user.id, username: user.username, roles: user.roles }
    },
    findUserIdentifiers: async (username) => {
      const user = [...users.values()].find(
        (item) => item.username === username
      )
      return (
        user && {
          userId: user.id,
          passwordHash: user.passwordHash,
          role: user.role,
        }
      )
    },
  }

  return { provider, users, refreshTokens }
}

export interface AuthAppOptions {
  settings?: Partial<AuthOptions>
  /** Adds `isSessionRevoked()` to the data provider. */
  sessionRevocation?: boolean
  plugin?: AuthPluginOptions
  /** `basePath` and `publicBasePath` of the app. */
  app?: Pick<AppOptions, 'basePath' | 'publicBasePath' | 'cors'>
  routes?: (router: Router) => void
}

export const createAuthApp = async (options: AuthAppOptions = {}) => {
  const store = createStore({ sessionRevocation: options.sessionRevocation })
  const auth = createAuth({
    keys,
    dataProvider: store.provider,
    issuer: 'https://api.example.com',
    passwordHashRounds: TEST_HASH_ROUNDS,
    ...options.settings,
  })

  const router = createRouter()
  options.routes?.(router)

  const app = await createTestApp({
    ...options.app,
    routers: [router],
    plugins: [authPlugin(auth, options.plugin)],
  })

  return { ...app, auth, store }
}

export const postJson = (
  body: unknown,
  headers: Record<string, string> = {}
) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

/** Cookies set by a response, by name. */
export const cookiesOf = (res: Response) =>
  Object.fromEntries(
    res.headers.getSetCookie().map((cookie) => {
      const [pair = ''] = cookie.split(';')
      const index = pair.indexOf('=')
      return [
        pair.slice(0, index),
        { value: pair.slice(index + 1), raw: cookie },
      ]
    })
  )

export const cookieHeader = (cookies: Record<string, string>) =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')

/** Login response in body mode (both tokens are returned). */
export interface LoginResponse {
  userId: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  expiresAt: string
}

export const login = async (
  fetch: (path: string, init?: RequestInit) => Promise<Response>,
  body: Record<string, unknown> = { username: 'ada', password: 'secret' }
) => {
  const res = await fetch('/auth/login', postJson(body))
  return { res, body: (await res.json()) as LoginResponse }
}
