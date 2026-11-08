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
  RefreshTokenData,
  ResolvedAuthSettings,
  ResolvedCookieSettings,
  TokenPair,
  TokenSubject,
} from './types.js'

const ALGORITHM = 'RS256'
/** Media type of the access tokens (RFC 9068). */
const ACCESS_TOKEN_TYPE = 'at+jwt'

export type AuthErrorCode =
  | 'INVALID_ACCESS_TOKEN'
  | 'INVALID_REFRESH_TOKEN'
  | 'EXPIRED_REFRESH_TOKEN'
  /** A used refresh token was presented again: its session is revoked. */
  | 'REFRESH_TOKEN_REUSED'

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
   *
   * A refresh token can only be used once. Within
   * `refreshTokenReuseInterval` after its first use, it may be presented
   * again (concurrent refreshes, retries after a lost response): a new pair
   * is issued in the same session. After, presenting it again means it was
   * probably stolen: the whole session (token family) is revoked, and
   * `REFRESH_TOKEN_REUSED` is thrown.
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
  /** Hashes a password with bcrypt. Defaults to `passwordHashRounds`. */
  hashPassword(password: string, saltRounds?: number): Promise<string>
  /**
   * Verifies a password against its bcrypt hash. Without valid hash
   * (unknown user, account without password), it compares the password
   * with a dummy hash and returns `false`: the answer takes the same time,
   * and does not reveal whether the account exists.
   */
  verifyPassword(
    password: string,
    passwordHash: string | null | undefined
  ): Promise<boolean>
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
  if (typeof settings.issuer !== 'string' || settings.issuer === '') {
    throw new TypeError(
      'createAuth() requires an issuer (iss claim), such as the URL of the API.'
    )
  }
  if (settings.audience !== undefined && settings.audience === '') {
    throw new TypeError('Invalid audience: expected a non-empty string.')
  }
  const clients = settings.clients
  if (
    clients &&
    (!Array.isArray(clients.allowed) ||
      clients.allowed.length === 0 ||
      clients.allowed.some((id) => typeof id !== 'string' || id === ''))
  ) {
    throw new TypeError(
      'Invalid clients.allowed: expected a non-empty list of client identifiers.'
    )
  }
  const rounds = settings.passwordHashRounds
  if (
    rounds !== undefined &&
    (!Number.isInteger(rounds) || rounds < 4 || rounds > 31)
  ) {
    throw new RangeError(
      'Invalid passwordHashRounds: expected an integer between 4 and 31.'
    )
  }
  const reuseInterval = settings.refreshTokenReuseInterval
  if (
    reuseInterval !== undefined &&
    (!Number.isFinite(reuseInterval) || reuseInterval < 0)
  ) {
    throw new RangeError(
      'Invalid refreshTokenReuseInterval: expected a non-negative number of seconds.'
    )
  }

  return {
    keys: settings.keys,
    dataProvider: settings.dataProvider,
    accessTokenTTL: settings.accessTokenTTL ?? 3600,
    refreshTokenTTLInDays: settings.refreshTokenTTLInDays ?? 14,
    issuer: settings.issuer,
    audience: settings.audience ?? settings.issuer,
    cookies: { ...DEFAULT_COOKIE_SETTINGS, ...settings.cookies },
    clients: settings.clients,
    onLoginFailed: settings.onLoginFailed,
    onLoginSuccess: settings.onLoginSuccess,
    passwordHashRounds: settings.passwordHashRounds ?? 10,
    refreshTokenReuseInterval: settings.refreshTokenReuseInterval ?? 10,
    onRefreshTokenReuse: settings.onRefreshTokenReuse,
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

/** bcrypt hash format: `$2a$`, `$2b$` or `$2y$`, cost, salt and hash. */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/

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
    clientId:
      typeof claims.client_id === 'string' ? claims.client_id : undefined,
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

  let dummyHash: Promise<string> | undefined
  /** Hash of a random password, with the configured cost. */
  const getDummyHash = () => {
    dummyHash ??= bcrypt.hash(
      toHex(crypto.getRandomValues(new Uint8Array(16))),
      settings.passwordHashRounds
    )
    return dummyHash
  }

  const signAccessToken = async (claims: {
    sub: string
    username: string
    auth_time: number
    client_id?: string
  }): Promise<CreatedAccessToken> => {
    const { privateKey } = await getKeys()
    const jwtId = crypto.randomUUID()
    const issuedAt = Math.floor(Date.now() / 1000)

    const token = await new SignJWT({
      username: claims.username,
      auth_time: claims.auth_time,
      ...(claims.client_id !== undefined && { client_id: claims.client_id }),
    })
      .setProtectedHeader({ alg: ALGORITHM, typ: ACCESS_TOKEN_TYPE })
      .setSubject(claims.sub)
      .setIssuer(settings.issuer)
      .setAudience(settings.audience)
      .setJti(jwtId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + settings.accessTokenTTL)
      .sign(privateKey)

    return { jwtId, accessToken: token }
  }

  const generateRefreshToken = async (): Promise<CreatedRefreshToken> => {
    const token = toHex(crypto.getRandomValues(new Uint8Array(128)))
    return { token, tokenHash: await sha256(token) }
  }

  const storeRefreshToken = async (
    userId: string,
    jwtId: string,
    familyId: string,
    refreshToken: CreatedRefreshToken
  ) =>
    settings.dataProvider.storeRefreshToken({
      ...refreshToken,
      userId,
      jwtId,
      familyId,
      expiresAt: addDaysFromNow(settings.refreshTokenTTLInDays),
    })

  /**
   * Handles a used refresh token presented again. Within the reuse
   * interval (counted from its first use), it is a concurrent refresh or a
   * retry after a lost response: returns, and a new token pair is issued in
   * the same session. After, the token was probably stolen: the session is
   * revoked.
   */
  const checkReuse = async (stored: RefreshTokenData): Promise<void> => {
    const usedAt = stored.usedAt?.getTime()
    if (
      usedAt !== undefined &&
      Date.now() - usedAt < settings.refreshTokenReuseInterval * 1000
    ) {
      return
    }

    const familyId = stored.familyId ?? undefined
    if (familyId) {
      await settings.dataProvider.revokeTokenFamily(familyId)
    } else {
      // Tokens stored without family: revoke every session of the user.
      await settings.dataProvider.revokeTokens(stored.userId)
    }

    try {
      await settings.onRefreshTokenReuse?.({
        userId: stored.userId,
        familyId,
        jwtId: stored.jwtId,
      })
    } catch {
      // The session is revoked; a failing notification must not hide it.
    }

    throw new AuthError('REFRESH_TOKEN_REUSED')
  }

  /** Whether the `clients` setting accepts a token client. */
  const isClientAccepted = (clientId: string | undefined) => {
    const { clients } = settings
    if (!clients) return true
    return clientId === undefined
      ? !clients.required
      : clients.allowed.includes(clientId)
  }

  const generateAccessToken = async ({
    userId,
    username,
    clientId,
  }: TokenSubject) => {
    if (!isClientAccepted(clientId)) {
      throw new TypeError(
        clientId === undefined
          ? 'A clientId is required by the clients setting.'
          : `Unknown client "${clientId}": add it to clients.allowed.`
      )
    }
    return signAccessToken({
      sub: userId,
      username,
      auth_time: Math.floor(Date.now() / 1000),
      client_id: clientId,
    })
  }

  const cookieOptions = () => {
    const { httpOnly, secure, sameSite, path, domain } = settings.cookies
    return { httpOnly, secure, sameSite, path, domain }
  }

  return {
    settings,

    init: async () => {
      // The dummy hash is computed now: otherwise, the first login of an
      // unknown user would take longer.
      await Promise.all([getKeys(), getDummyHash()])
    },

    generateAccessToken,

    generateRefreshToken,

    async generateTokensForUser(subject) {
      const { jwtId, accessToken } = await generateAccessToken(subject)
      const refreshToken = await generateRefreshToken()
      await storeRefreshToken(
        subject.userId,
        jwtId,
        crypto.randomUUID(),
        refreshToken
      )
      return { accessToken, refreshToken: refreshToken.token }
    },

    async refreshTokens({ accessToken, refreshToken }) {
      const { publicKey } = await getKeys()

      let claims: Record<string, unknown>
      let legacy: boolean
      try {
        // Signature only: the access token is usually expired here, and
        // `iss`, `aud` and `typ` are not checked, so that tokens issued
        // by V1 (or before a configuration change) are migrated. The
        // stored refresh token proves the session.
        const { payload, protectedHeader } = await compactVerify(
          accessToken,
          publicKey,
          { algorithms: [ALGORITHM] }
        )
        claims = JSON.parse(new TextDecoder().decode(payload)) as Record<
          string,
          unknown
        >
        legacy = protectedHeader.typ !== ACCESS_TOKEN_TYPE
      } catch (error) {
        throw new AuthError('INVALID_REFRESH_TOKEN', { cause: error })
      }

      const userId = typeof claims.sub === 'string' ? claims.sub : ''
      const clientId =
        typeof claims.client_id === 'string'
          ? claims.client_id
          : // V1 tokens carried the client in `aud`.
            legacy &&
              typeof claims.aud === 'string' &&
              settings.clients?.allowed.includes(claims.aud)
            ? claims.aud
            : undefined
      const refreshTokenHash = await sha256(refreshToken)
      const stored =
        await settings.dataProvider.findRefreshToken(refreshTokenHash)

      // Unknown token, or token presented with an access token it was not
      // issued with: nothing proves possession of the session.
      if (
        !userId ||
        !stored ||
        stored.userId !== userId ||
        stored.jwtId !== claims.jti ||
        stored.revokedAt ||
        // Client removed from the configuration: the session ends.
        !isClientAccepted(clientId)
      ) {
        throw new AuthError('INVALID_REFRESH_TOKEN')
      }

      if (stored.isUsed) await checkReuse(stored)

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
        client_id: clientId,
      })

      const newRefreshToken = await generateRefreshToken()
      await storeRefreshToken(
        userId,
        created.jwtId,
        // Tokens stored without family start one, derived from the token
        // so that concurrent rotations land in the same family.
        stored.familyId || stored.jwtId,
        newRefreshToken
      )
      // A token reused within the interval keeps its first use date: the
      // interval cannot be extended by presenting it again.
      if (!stored.isUsed) {
        await settings.dataProvider.markRefreshTokenAsUsed(
          refreshTokenHash,
          new Date()
        )
      }

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
          typ: ACCESS_TOKEN_TYPE,
          issuer: settings.issuer,
          audience: settings.audience,
        })
        const session = toSession(payload as Record<string, unknown>, [])
        if (!isClientAccepted(session.clientId)) {
          throw new AuthError('INVALID_ACCESS_TOKEN')
        }
        return session
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

    hashPassword: (password, saltRounds = settings.passwordHashRounds) =>
      bcrypt.hash(password, saltRounds),

    async verifyPassword(password, passwordHash) {
      if (typeof passwordHash === 'string' && BCRYPT_HASH.test(passwordHash)) {
        return bcrypt.compare(password, passwordHash)
      }
      await bcrypt.compare(password, await getDummyHash())
      return false
    },
  }
}

/**
 * Hashes a password with bcrypt.
 */
export const generatePasswordHash = (
  password: string,
  saltRounds = 10
): Promise<string> => bcrypt.hash(password, saltRounds)
