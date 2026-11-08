import type { DotpressResponse } from '@dotpress/core'
import bcrypt from 'bcryptjs'
import {
  SignJWT,
  compactVerify,
  importPKCS8,
  importSPKI,
  jwtVerify,
} from 'jose'
import type {
  AuthSession,
  AuthSettings,
  AuthUser,
  CreatedAccessToken,
  CreatedRefreshToken,
  ResolvedAuthSettings,
  ResolvedCookieSettings,
  TokenPair,
  TokenSubject,
} from './types.js'

const ALGORITHM = 'RS256'

export type AuthErrorCode =
  'INVALID_ACCESS_TOKEN' | 'INVALID_REFRESH_TOKEN' | 'EXPIRED_REFRESH_TOKEN'

/**
 * Error raised by the token helpers.
 */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options)
    this.name = 'AuthError'
  }
}

export interface Auth {
  readonly settings: ResolvedAuthSettings
  /** Imports the keys. Fails with an explicit message on invalid keys. */
  init(): Promise<void>
  generateAccessToken(subject: TokenSubject): Promise<CreatedAccessToken>
  generateRefreshToken(): Promise<CreatedRefreshToken>
  /** Generates and stores a token pair. */
  generateTokensForUser(subject: TokenSubject): Promise<TokenPair>
  /**
   * Rotates a token pair. The access token may be expired, but must be
   * signed by the key pair and match the refresh token.
   */
  refreshTokens(tokens: TokenPair): Promise<TokenPair & { userId: string }>
  /** Verifies a valid (not expired) access token. */
  verifyAccessToken(accessToken: string): Promise<AuthSession>
  /** Roles of a user, from the `getUserRoles` setting. */
  getUserRoles(user: AuthUser): readonly string[]
  /**
   * Sets the token cookies (cookie mode only). Defaults to the refresh
   * token lifetime.
   */
  setAuthCookies(
    res: DotpressResponse,
    tokens: TokenPair,
    expiresInSeconds?: number
  ): void
  clearAuthCookies(res: DotpressResponse): void
  hashPassword(password: string, saltRounds?: number): Promise<string>
  verifyPassword(password: string, passwordHash: string): Promise<boolean>
}

const DEFAULT_COOKIE_SETTINGS: ResolvedCookieSettings = {
  enabled: false,
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  accessTokenName: 'dotpress_access_token',
  refreshTokenName: 'dotpress_refresh_token',
  accessTokenInCookie: false,
  domain: undefined,
}

const defaultUserRoles = (user: AuthUser): readonly string[] => {
  const { roles, role } = user as { roles?: unknown; role?: unknown }
  if (Array.isArray(roles)) {
    return roles.filter((value): value is string => typeof value === 'string')
  }
  return typeof role === 'string' ? [role] : []
}

const resolveSettings = (settings: AuthSettings): ResolvedAuthSettings => {
  if (!settings?.keys?.secretKey || !settings.keys.publicKey) {
    throw new TypeError(
      'createAuth() requires keys.secretKey and keys.publicKey.'
    )
  }
  if (!settings.dataProvider) {
    throw new TypeError('createAuth() requires a dataProvider.')
  }

  return {
    keys: settings.keys,
    dataProvider: settings.dataProvider,
    accessTokenTTL: settings.accessTokenTTL ?? 3600,
    refreshTokenTTLInDays: settings.refreshTokenTTLInDays ?? 14,
    issuer: settings.issuer ?? '',
    cookies: { ...DEFAULT_COOKIE_SETTINGS, ...settings.cookies },
    aud: settings.aud,
    onLoginFailed: settings.onLoginFailed,
    onLoginSuccess: settings.onLoginSuccess,
    getUserRoles: settings.getUserRoles ?? defaultUserRoles,
  }
}

const importKeys = async ({
  secretKey,
  publicKey,
}: ResolvedAuthSettings['keys']) => {
  if (secretKey.includes('BEGIN RSA PRIVATE KEY')) {
    throw new TypeError(
      'Invalid auth secretKey: PKCS#1 keys ("BEGIN RSA PRIVATE KEY") are not supported, use PKCS#8 ("BEGIN PRIVATE KEY"). Convert it with: openssl pkcs8 -topk8 -nocrypt -in private.pem -out private.pkcs8.pem'
    )
  }
  if (publicKey.includes('BEGIN RSA PUBLIC KEY')) {
    throw new TypeError(
      'Invalid auth publicKey: PKCS#1 keys ("BEGIN RSA PUBLIC KEY") are not supported, use SPKI ("BEGIN PUBLIC KEY"). Convert it with: openssl rsa -RSAPublicKey_in -in public.pem -pubout -out public.spki.pem'
    )
  }

  const load = async (kind: string, load: () => Promise<CryptoKey>) => {
    try {
      return await load()
    } catch (error) {
      throw new TypeError(
        `Invalid auth ${kind}: expected an RSA PEM key (${(error as Error).message}).`,
        { cause: error }
      )
    }
  }

  return {
    privateKey: await load('secretKey', () =>
      importPKCS8(secretKey, ALGORITHM)
    ),
    publicKey: await load('publicKey', () => importSPKI(publicKey, ALGORITHM)),
  }
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const sha256 = async (value: string) =>
  toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    )
  )

const addDaysFromNow = (days: number): Date => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date
}

const toSession = (
  claims: Record<string, unknown>,
  roles: readonly string[]
): AuthSession => {
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new AuthError('INVALID_ACCESS_TOKEN')
  }
  return {
    userId: claims.sub,
    username: typeof claims.username === 'string' ? claims.username : '',
    tokenId: typeof claims.jti === 'string' ? claims.jti : '',
    audience: typeof claims.aud === 'string' ? claims.aud : undefined,
    roles,
    claims,
  }
}

/**
 * Creates the authentication service. It works without an app (scripts,
 * workers), and is plugged into an app with `authPlugin()`.
 *
 * @example
 * const auth = createAuth({ keys, dataProvider })
 * await createApp({ adapter, plugins: [authPlugin(auth)] })
 */
export const createAuth = (input: AuthSettings): Auth => {
  const settings = resolveSettings(input)
  let keys: ReturnType<typeof importKeys> | undefined

  const getKeys = () => {
    keys ??= importKeys(settings.keys).catch((error: unknown) => {
      // Allows a later call to retry, and to report the error again.
      keys = undefined
      throw error
    })
    return keys
  }

  const signAccessToken = async (claims: {
    sub: string
    username: string
    auth_time: number
    aud?: string
  }): Promise<CreatedAccessToken> => {
    const { privateKey } = await getKeys()
    const jwtId = crypto.randomUUID()
    const issuedAt = Math.floor(Date.now() / 1000)

    const token = new SignJWT({
      username: claims.username,
      auth_time: claims.auth_time,
    })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(settings.issuer)
      .setJti(jwtId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + settings.accessTokenTTL)

    if (claims.aud) token.setAudience(claims.aud)

    return { jwtId, accessToken: await token.sign(privateKey) }
  }

  const generateRefreshToken = async (): Promise<CreatedRefreshToken> => {
    const token = toHex(crypto.getRandomValues(new Uint8Array(128)))
    return { token, tokenHash: await sha256(token) }
  }

  const storeRefreshToken = async (
    userId: string,
    jwtId: string,
    refreshToken: CreatedRefreshToken
  ) =>
    settings.dataProvider.storeRefreshToken({
      ...refreshToken,
      userId,
      jwtId,
      expiresAt: addDaysFromNow(settings.refreshTokenTTLInDays),
    })

  const generateAccessToken = ({ userId, username, aud }: TokenSubject) =>
    signAccessToken({
      sub: userId,
      username,
      auth_time: Math.floor(Date.now() / 1000),
      aud,
    })

  const cookieOptions = () => {
    const { httpOnly, secure, sameSite, path, domain } = settings.cookies
    return { httpOnly, secure, sameSite, path, domain }
  }

  return {
    settings,

    init: async () => {
      await getKeys()
    },

    generateAccessToken,

    generateRefreshToken,

    async generateTokensForUser(subject) {
      const { jwtId, accessToken } = await generateAccessToken(subject)
      const refreshToken = await generateRefreshToken()
      await storeRefreshToken(subject.userId, jwtId, refreshToken)
      return { accessToken, refreshToken: refreshToken.token }
    },

    async refreshTokens({ accessToken, refreshToken }) {
      const { publicKey } = await getKeys()

      let claims: Record<string, unknown>
      try {
        // Signature only: the access token is usually expired here.
        const { payload } = await compactVerify(accessToken, publicKey, {
          algorithms: [ALGORITHM],
        })
        claims = JSON.parse(new TextDecoder().decode(payload)) as Record<
          string,
          unknown
        >
      } catch (error) {
        throw new AuthError('INVALID_REFRESH_TOKEN', { cause: error })
      }

      const userId = typeof claims.sub === 'string' ? claims.sub : ''
      const refreshTokenHash = await sha256(refreshToken)
      const stored =
        await settings.dataProvider.findRefreshToken(refreshTokenHash)

      if (
        !userId ||
        !stored ||
        stored.revokedAt ||
        stored.isUsed ||
        stored.userId !== userId ||
        stored.jwtId !== claims.jti
      ) {
        throw new AuthError('INVALID_REFRESH_TOKEN')
      }

      if (stored.expiresAt.getTime() <= Date.now()) {
        throw new AuthError('EXPIRED_REFRESH_TOKEN')
      }

      const created = await signAccessToken({
        sub: userId,
        username: typeof claims.username === 'string' ? claims.username : '',
        auth_time:
          typeof claims.auth_time === 'number'
            ? claims.auth_time
            : Math.floor(Date.now() / 1000),
        aud: typeof claims.aud === 'string' ? claims.aud : undefined,
      })

      const newRefreshToken = await generateRefreshToken()
      await storeRefreshToken(userId, created.jwtId, newRefreshToken)
      await settings.dataProvider.markRefreshTokenAsUsed(refreshTokenHash)

      return {
        userId,
        accessToken: created.accessToken,
        refreshToken: newRefreshToken.token,
      }
    },

    async verifyAccessToken(accessToken) {
      const { publicKey } = await getKeys()
      try {
        const { payload } = await jwtVerify(accessToken, publicKey, {
          algorithms: [ALGORITHM],
        })
        return toSession(payload as Record<string, unknown>, [])
      } catch (error) {
        if (error instanceof AuthError) throw error
        throw new AuthError('INVALID_ACCESS_TOKEN', { cause: error })
      }
    },

    getUserRoles: (user) => settings.getUserRoles(user),

    setAuthCookies(res, tokens, expiresInSeconds) {
      const cookies = settings.cookies
      if (!cookies.enabled) return

      const options = {
        ...cookieOptions(),
        maxAge:
          expiresInSeconds ?? settings.refreshTokenTTLInDays * 24 * 60 * 60,
      }

      res.setCookie(cookies.refreshTokenName, tokens.refreshToken, options)
      if (cookies.accessTokenInCookie) {
        res.setCookie(cookies.accessTokenName, tokens.accessToken, options)
      }
    },

    clearAuthCookies(res) {
      const cookies = settings.cookies
      if (!cookies.enabled) return

      res.clearCookie(cookies.refreshTokenName, cookieOptions())
      if (cookies.accessTokenInCookie) {
        res.clearCookie(cookies.accessTokenName, cookieOptions())
      }
    },

    hashPassword: (password, saltRounds = 10) =>
      bcrypt.hash(password, saltRounds),

    verifyPassword: (password, passwordHash) =>
      bcrypt.compare(password, passwordHash),
  }
}

/**
 * Hashes a password with bcrypt.
 */
export const generatePasswordHash = (
  password: string,
  saltRounds = 10
): Promise<string> => bcrypt.hash(password, saltRounds)
