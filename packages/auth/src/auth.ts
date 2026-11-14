import {
  createMemoryRateLimitStore,
  parseDuration,
  type DotpressRequest,
  type DotpressResponse,
  type PluginCors,
} from '@dotpress/core'
import bcrypt from 'bcryptjs'
import {
  CompactSign,
  SignJWT,
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  errors,
  exportJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  type JWK,
} from 'jose'
import { sha256, toHex } from './crypto.js'
import { isCookieAuthenticationAllowed } from './csrf.js'
import type {
  AuthInitOptions,
  AuthSession,
  AuthOptions,
  AuthUser,
  AuthCookieOptions,
  ClientOptions,
  KeyPairOptions,
  CreatedAccessToken,
  CreatedRefreshToken,
  IssuedTokens,
  LoginThrottleOptions,
  LogoutScope,
  RateLimit,
  RefreshTokenData,
  ResolvedRateLimit,
  ResolvedAuthOptions,
  ResolvedCookieOptions,
  ResolvedLoginThrottleOptions,
  ResolvedSessionOptions,
  RevokedSession,
  SessionOptions,
  TokenPair,
  TokenSubject,
} from './types.js'

const ALGORITHM = 'RS256'
/** Media type of the access tokens (RFC 9068). */
const ACCESS_TOKEN_TYPE = 'at+jwt'
const DEFAULT_IDLE_TIMEOUT = 14 * 24 * 60 * 60

export type AuthErrorCode =
  | 'INVALID_ACCESS_TOKEN'
  | 'INVALID_REFRESH_TOKEN'
  | 'EXPIRED_REFRESH_TOKEN'
  /** A used refresh token was presented again: its session is revoked. */
  | 'REFRESH_TOKEN_REUSED'
  /** Valid access token of a revoked session (`isSessionRevoked()`). */
  | 'SESSION_REVOKED'

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
  /** Generates and stores a token pair, starting a session. */
  generateTokensForUser(subject: TokenSubject): Promise<IssuedTokens>
  /**
   * Rotates a token pair. The access token may be expired, but must be
   * signed by the key pair and match the refresh token.
   *
   * A refresh token can only be used once. Within
   * `refreshTokenReuseInterval` after its first use, it may be presented
   * again (concurrent refreshes, retries after a lost response): a new pair
   * is issued in the same session. After, presenting it again means it was
   * probably stolen: the whole session is revoked, and
   * `REFRESH_TOKEN_REUSED` is thrown.
   *
   * Throws `EXPIRED_REFRESH_TOKEN` when the session reached its inactivity
   * or absolute timeout, and `INVALID_REFRESH_TOKEN` when
   * `findUserById()` no longer returns the user (the session is revoked).
   */
  refreshTokens(
    tokens: TokenPair
  ): Promise<IssuedTokens & { userId: string; user: AuthUser }>
  /**
   * Verifies a valid (not expired) access token. With
   * `DataProvider.isSessionRevoked()`, throws `SESSION_REVOKED` for the
   * tokens of a revoked session.
   */
  verifyAccessToken(accessToken: string): Promise<AuthSession>
  /**
   * Revokes the session of a refresh token (logout). The token may be
   * used, revoked or expired: it still designates its session. Tokens
   * stored before sessions (V1) revoke every session of the user.
   *
   * With `scope: 'all'`, revokes every session of the user, on every
   * device. The token must then be active (neither used, revoked nor
   * expired).
   *
   * Returns `undefined`, without revoking anything, for an unknown token,
   * or an inactive token with `scope: 'all'`.
   */
  revokeSession(
    refreshToken: string,
    options?: { scope?: LogoutScope }
  ): Promise<RevokedSession | undefined>
  /**
   * Revokes every session of a user, on every device: after a password
   * change, or when an account is disabled. Their refresh tokens stop
   * working at once; their access tokens too with
   * `DataProvider.isSessionRevoked()`, else at their expiry.
   */
  revokeUserSessions(userId: string): Promise<void>
  /**
   * End of a session, when an absolute timeout applies to it (computed
   * from the `auth_time` claim).
   */
  getSessionExpiresAt(session: AuthSession): Date | undefined
  /**
   * Public keys as a JSON Web Key Set (RFC 7517): the active key first,
   * then the additional keys. Other services can verify the tokens with
   * it (`createRemoteJWKSet()` of jose).
   */
  getJwks(): Promise<{ keys: JWK[] }>
  /** Roles of a user, from the `getUserRoles` setting. */
  getUserRoles(user: AuthUser): readonly string[]
  /**
   * Sets the token cookies (cookie mode only). They expire with the
   * refresh token (`refreshTokenExpiresAt` of issued tokens), or after the
   * inactivity timeout.
   */
  setAuthCookies(
    res: DotpressResponse,
    tokens: TokenPair & { refreshTokenExpiresAt?: Date }
  ): void
  clearAuthCookies(res: DotpressResponse): void
  /**
   * Whether a request may be authenticated by the cookies: protection
   * against cross-site request forgery (see `cookies.trustedOrigins`).
   * `authPlugin()` checks it on its routes and before reading the access
   * token cookie.
   */
  isCookieAuthenticationAllowed(req: DotpressRequest): Promise<boolean>
  /**
   * Hashes a password with bcrypt, with `passwordHashRounds`. Throws a
   * `RangeError` for passwords longer than 72 bytes (see
   * `isPasswordTooLong()`).
   */
  hashPassword(password: string): Promise<string>
  /** Whether a bcrypt hash has another cost than `passwordHashRounds`. */
  passwordNeedsRehash(passwordHash: string): boolean
  /**
   * Hashes a verified password with `passwordHashRounds`, to upgrade its
   * stored hash. Unlike `hashPassword()`, it accepts passwords longer than
   * 72 bytes, created before the check.
   */
  rehashPassword(password: string): Promise<string>
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

/** What `authPlugin()` needs of an auth service, besides its methods. */
export interface AuthInternals {
  readonly settings: ResolvedAuthOptions
  /**
   * Imports the keys. Fails with an explicit message on invalid keys.
   * `authPlugin()` calls it at startup, with the browser path of its routes.
   */
  init(options?: AuthInitOptions): Promise<void>
}

const internals = new WeakMap<Auth, AuthInternals>()

/**
 * The internals of a service created by `createAuth()`, or `undefined` for
 * any other value.
 */
export const internalsOf = (auth: unknown): AuthInternals | undefined =>
  typeof auth === 'object' && auth !== null
    ? internals.get(auth as Auth)
    : undefined

/** A duration option, in whole seconds, at least `min`. */
const wholeSeconds = (label: string, value: unknown, min: number) => {
  const result = Math.round(parseDuration(value, label) / 1000)
  if (result < min) {
    throw new RangeError(
      `Invalid ${label}: expected ${min === 0 ? 'a non-negative' : `at least ${min} second`} duration.`
    )
  }
  return result
}

/** Throws a `TypeError` for an unknown key of `options`. */
const assertKnown = (
  options: unknown,
  known: readonly string[],
  prefix = ''
): void => {
  if (options === undefined) return
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(
      `createAuth(): ${prefix ? prefix.slice(0, -1) : 'options'} must be an object.`
    )
  }
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) {
      throw new TypeError(`createAuth(): unknown option "${prefix}${key}".`)
    }
  }
}

const OPTIONS = [
  'keys',
  'dataProvider',
  'accessTokenTTL',
  'session',
  'issuer',
  'audience',
  'cookies',
  'clients',
  'onLoginFailed',
  'onLoginSuccess',
  'loginThrottle',
  'beforeLogin',
  'passwordHashRounds',
  'usernameClaim',
  'refreshTokenReuseInterval',
  'onRefreshTokenReuse',
  'getUserRoles',
] satisfies (keyof AuthOptions)[]

const KEY_OPTIONS = [
  'privateKey',
  'publicKey',
  'kid',
  'additionalPublicKeys',
] satisfies (keyof KeyPairOptions)[]

const SESSION_OPTIONS = [
  'idleTimeout',
  'absoluteTimeout',
] satisfies (keyof SessionOptions)[]

const CLIENT_OPTIONS = [
  'allowed',
  'required',
  'isUserRoleAllowed',
  'sessions',
] satisfies (keyof ClientOptions)[]

const DEFAULT_COOKIE_SETTINGS: ResolvedCookieOptions = {
  enabled: false,
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  refreshTokenPath: '/auth',
  refreshTokenSameSite: 'strict',
  trustedOrigins: [],
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

/** Session lifetimes in seconds; missing keys stay missing. */
const resolveSession = (
  session: SessionOptions | undefined,
  name: string
): Partial<ResolvedSessionOptions> => {
  assertKnown(session, SESSION_OPTIONS, `${name}.`)
  const resolved: Partial<ResolvedSessionOptions> = {}
  for (const key of SESSION_OPTIONS) {
    if (session === undefined || !(key in session)) continue
    const value = session[key]
    // An explicit `absoluteTimeout: undefined` removes the global limit.
    resolved[key] =
      value === undefined ? undefined : wholeSeconds(`${name}.${key}`, value, 1)
  }
  return resolved
}

const DEFAULT_LOGIN_LIMITS = {
  usernameAndIp: { max: 5, window: 60 },
  username: { max: 100, window: 60 * 60 },
} as const

const resolveLoginThrottle = (
  input: LoginThrottleOptions | false | undefined
): ResolvedLoginThrottleOptions | undefined => {
  if (input === false) return undefined

  assertKnown(input, ['store', 'limits'], 'loginThrottle.')
  assertKnown(
    input?.limits,
    ['usernameAndIp', 'username'],
    'loginThrottle.limits.'
  )

  const limit = (
    name: keyof typeof DEFAULT_LOGIN_LIMITS
  ): ResolvedRateLimit | undefined => {
    const value = input?.limits?.[name]
    if (value === false) return undefined
    const resolved: RateLimit = value ?? DEFAULT_LOGIN_LIMITS[name]
    assertKnown(
      resolved,
      ['max', 'window'] satisfies (keyof RateLimit)[],
      `loginThrottle.limits.${name}.`
    )
    if (!Number.isInteger(resolved.max) || resolved.max < 1) {
      throw new RangeError(
        `Invalid loginThrottle.limits.${name}.max: expected a positive integer.`
      )
    }
    return {
      max: resolved.max,
      window: wholeSeconds(
        `loginThrottle.limits.${name}.window`,
        resolved.window,
        1
      ),
    }
  }

  const store = input?.store ?? createMemoryRateLimitStore()
  if (
    typeof store.increment !== 'function' ||
    typeof store.reset !== 'function'
  ) {
    throw new TypeError(
      'Invalid loginThrottle.store: expected increment() and reset() methods.'
    )
  }

  return {
    store,
    limits: {
      usernameAndIp: limit('usernameAndIp'),
      username: limit('username'),
    },
  }
}

const resolveSettings = (settings: AuthOptions): ResolvedAuthOptions => {
  if (typeof settings !== 'object' || settings === null) {
    throw new TypeError('createAuth() requires an options object.')
  }
  if ('refreshTokenTTLInDays' in settings) {
    throw new TypeError(
      'refreshTokenTTLInDays is replaced by session.idleTimeout, in seconds.'
    )
  }
  if (
    typeof settings.keys === 'object' &&
    settings.keys !== null &&
    'secretKey' in settings.keys
  ) {
    throw new TypeError('keys.secretKey is renamed keys.privateKey.')
  }
  assertKnown(settings, OPTIONS)
  assertKnown(settings.keys, KEY_OPTIONS, 'keys.')
  for (const [index, entry] of (
    settings.keys?.additionalPublicKeys ?? []
  ).entries()) {
    if (typeof entry !== 'string') {
      assertKnown(
        entry,
        ['publicKey', 'kid'],
        `keys.additionalPublicKeys[${index}].`
      )
    }
  }
  assertKnown(settings.clients, CLIENT_OPTIONS, 'clients.')
  assertKnown(
    settings.cookies,
    Object.keys(DEFAULT_COOKIE_SETTINGS),
    'cookies.'
  )
  if (!settings?.keys?.privateKey || !settings.keys.publicKey) {
    throw new TypeError(
      'createAuth() requires keys.privateKey and keys.publicKey.'
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
  for (const origin of settings.cookies?.trustedOrigins ?? []) {
    let valid = false
    try {
      valid = new URL(origin).origin === origin
    } catch {
      // Invalid URL.
    }
    if (!valid) {
      throw new TypeError(
        `Invalid cookies.trustedOrigins: "${origin}" is not an origin (expected a scheme and a host, such as https://app.example.com, without path or trailing slash).`
      )
    }
  }
  const session = resolveSession(settings.session, 'session')
  const clientSessions: Record<string, Partial<ResolvedSessionOptions>> = {}
  for (const [clientId, override] of Object.entries(clients?.sessions ?? {})) {
    if (!clients?.allowed.includes(clientId)) {
      throw new TypeError(
        `Invalid clients.sessions: "${clientId}" is not in clients.allowed.`
      )
    }
    clientSessions[clientId] = resolveSession(
      override,
      `clients.sessions.${clientId}`
    )
  }
  const optional = (
    label: 'accessTokenTTL' | 'refreshTokenReuseInterval',
    fallback: number,
    min: number
  ) =>
    settings[label] === undefined
      ? fallback
      : wholeSeconds(label, settings[label], min)

  return {
    keys: settings.keys,
    dataProvider: settings.dataProvider,
    accessTokenTTL: optional('accessTokenTTL', 900, 1),
    session: {
      idleTimeout: session.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
      absoluteTimeout: session.absoluteTimeout,
    },
    clientSessions,
    issuer: settings.issuer,
    audience: settings.audience ?? settings.issuer,
    cookies: resolveCookies(settings.cookies),
    clients: settings.clients,
    onLoginFailed: settings.onLoginFailed,
    onLoginSuccess: settings.onLoginSuccess,
    loginThrottle: resolveLoginThrottle(settings.loginThrottle),
    beforeLogin: settings.beforeLogin,
    passwordHashRounds: settings.passwordHashRounds ?? 12,
    usernameClaim: settings.usernameClaim ?? false,
    refreshTokenReuseInterval: optional('refreshTokenReuseInterval', 10, 0),
    onRefreshTokenReuse: settings.onRefreshTokenReuse,
    getUserRoles: settings.getUserRoles ?? defaultUserRoles,
  }
}

/**
 * Name of a cookie. Like Auth.js, the default names get the strongest
 * prefix the attributes allow: `__Host-` (secure, no domain, path `/`)
 * cannot be overwritten by a subdomain or an insecure page; `__Secure-`
 * (secure) cannot be overwritten by an insecure page.
 */
const cookieName = (
  setting: 'accessTokenName' | 'refreshTokenName',
  name: string | undefined,
  base: string,
  attributes: { secure: boolean; domain: string | undefined; path: string }
) => {
  const { secure, domain, path } = attributes
  const hostAllowed = secure && domain === undefined && path === '/'
  if (name === undefined) {
    if (!secure) return base
    return hostAllowed ? `__Host-${base}` : `__Secure-${base}`
  }

  // Browsers silently reject a prefixed cookie without its requirements.
  const lowerName = name.toLowerCase()
  if (lowerName.startsWith('__host-') && !hostAllowed) {
    throw new TypeError(
      `Invalid cookies.${setting}: a __Host- cookie must be secure, without domain, and with path "/".`
    )
  }
  if (lowerName.startsWith('__secure-') && !secure) {
    throw new TypeError(
      `Invalid cookies.${setting}: a __Secure- cookie must be secure.`
    )
  }
  return name
}

const resolveCookies = (
  settings: AuthCookieOptions = {}
): ResolvedCookieOptions => {
  const merged: ResolvedCookieOptions = { ...DEFAULT_COOKIE_SETTINGS }
  for (const [key, value] of Object.entries(settings)) {
    // An explicit `undefined` keeps the default.
    if (value !== undefined) Object.assign(merged, { [key]: value })
  }
  for (const key of ['path', 'refreshTokenPath'] as const) {
    if (!merged[key].startsWith('/')) {
      throw new TypeError(
        `Invalid cookies.${key}: expected a path starting with "/".`
      )
    }
  }
  const { secure, domain } = merged

  return {
    ...merged,
    refreshTokenSameSite:
      settings.refreshTokenSameSite ??
      (settings.sameSite === 'none' ? 'none' : 'strict'),
    accessTokenName: cookieName(
      'accessTokenName',
      settings.accessTokenName,
      'dotpress_access_token',
      { secure, domain, path: merged.path }
    ),
    refreshTokenName: cookieName(
      'refreshTokenName',
      settings.refreshTokenName,
      'dotpress_refresh_token',
      { secure, domain, path: merged.refreshTokenPath }
    ),
  }
}

const PKCS1_PUBLIC_KEY_ERROR =
  'PKCS#1 keys ("BEGIN RSA PUBLIC KEY") are not supported, use SPKI ("BEGIN PUBLIC KEY"). Convert it with: openssl rsa -RSAPublicKey_in -in public.pem -pubout -out public.spki.pem'

/** Public key accepted to verify tokens. */
interface VerificationKey {
  kid: string
  key: CryptoKey
  jwk: JWK
}

const loadKey = async (kind: string, load: () => Promise<CryptoKey>) => {
  try {
    return await load()
  } catch (error) {
    throw new TypeError(
      `Invalid auth ${kind}: expected an RSA PEM key (${(error as Error).message}).`,
      { cause: error }
    )
  }
}

const loadPublicKey = async (
  kind: string,
  pem: string,
  kid: string | undefined
): Promise<VerificationKey> => {
  if (pem.includes('BEGIN RSA PUBLIC KEY')) {
    throw new TypeError(`Invalid auth ${kind}: ${PKCS1_PUBLIC_KEY_ERROR}`)
  }
  const key = await loadKey(kind, () =>
    importSPKI(pem, ALGORITHM, { extractable: true })
  )
  const { kty, n, e } = await exportJWK(key)
  const jwk: JWK = { kty, n, e }
  return { kid: kid ?? (await calculateJwkThumbprint(jwk)), key, jwk }
}

const importKeys = async ({
  privateKey,
  publicKey,
  kid,
  additionalPublicKeys = [],
}: ResolvedAuthOptions['keys']) => {
  if (privateKey.includes('BEGIN RSA PRIVATE KEY')) {
    throw new TypeError(
      'Invalid auth privateKey: PKCS#1 keys ("BEGIN RSA PRIVATE KEY") are not supported, use PKCS#8 ("BEGIN PRIVATE KEY"). Convert it with: openssl pkcs8 -topk8 -nocrypt -in private.pem -out private.pkcs8.pem'
    )
  }

  const signingKey = await loadKey('privateKey', () =>
    importPKCS8(privateKey, ALGORITHM)
  )
  const active = await loadPublicKey('publicKey', publicKey, kid)

  // A public key that does not match the private key would reject every
  // token: fail at startup instead.
  try {
    const probe = await new CompactSign(new Uint8Array([1]))
      .setProtectedHeader({ alg: ALGORITHM })
      .sign(signingKey)
    await compactVerify(probe, active.key)
  } catch (error) {
    throw new TypeError(
      'Invalid auth keys: publicKey does not match privateKey.',
      { cause: error }
    )
  }

  const verificationKeys = [active]
  for (const [index, entry] of additionalPublicKeys.entries()) {
    const { publicKey: pem, kid: entryKid } =
      typeof entry === 'string' ? { publicKey: entry, kid: undefined } : entry
    const loaded = await loadPublicKey(
      `additionalPublicKeys[${index}]`,
      pem,
      entryKid
    )
    const existing = verificationKeys.find((item) => item.kid === loaded.kid)
    if (!existing) {
      verificationKeys.push(loaded)
    } else if (
      existing.jwk.n !== loaded.jwk.n ||
      existing.jwk.e !== loaded.jwk.e
    ) {
      throw new TypeError(
        `Invalid auth keys: kid "${loaded.kid}" is used by several keys.`
      )
    }
  }

  return { signingKey, kid: active.kid, verificationKeys }
}

/**
 * Verifies a token with the key designated by its `kid` header, chosen
 * among the configured keys only. Tokens without `kid` (issued by V1) are
 * tried with every key.
 */
const verifyWithKeys = async <T>(
  token: string,
  verificationKeys: readonly VerificationKey[],
  verify: (key: CryptoKey) => Promise<T>
): Promise<T> => {
  const { kid } = decodeProtectedHeader(token)
  const candidates =
    kid === undefined
      ? verificationKeys
      : verificationKeys.filter((item) => item.kid === kid)
  if (candidates.length === 0) {
    throw new errors.JWKSNoMatchingKey(`Unknown key id: ${String(kid)}`)
  }

  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return await verify(candidate.key)
    } catch (error) {
      // Only a signature mismatch means another key may match.
      if (!(error instanceof errors.JWSSignatureVerificationFailed)) throw error
      lastError = error
    }
  }
  throw lastError
}

/** bcrypt hash format: `$2a$`, `$2b$` or `$2y$`, cost, salt and hash. */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/

const nowInSeconds = () => Math.floor(Date.now() / 1000)

const toSession = (
  claims: Record<string, unknown>,
  roles: readonly string[]
): AuthSession => {
  if (
    typeof claims.sub !== 'string' ||
    claims.sub === '' ||
    typeof claims.sid !== 'string' ||
    claims.sid === ''
  ) {
    throw new AuthError('INVALID_ACCESS_TOKEN')
  }
  return {
    userId: claims.sub,
    username: typeof claims.username === 'string' ? claims.username : undefined,
    accessTokenId: typeof claims.jti === 'string' ? claims.jti : '',
    sessionId: claims.sid,
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
export const createAuth = (input: AuthOptions): Auth => {
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

  /** Session lifetimes of a client. */
  const sessionPolicy = (
    clientId: string | undefined
  ): ResolvedSessionOptions => {
    const override =
      clientId === undefined ? undefined : settings.clientSessions[clientId]
    if (!override) return settings.session
    return {
      idleTimeout: override.idleTimeout ?? settings.session.idleTimeout,
      absoluteTimeout:
        'absoluteTimeout' in override
          ? override.absoluteTimeout
          : settings.session.absoluteTimeout,
    }
  }

  /** End of a session started at `authTime`, in seconds, if bounded. */
  const sessionEnd = (authTime: number, clientId: string | undefined) => {
    const { absoluteTimeout } = sessionPolicy(clientId)
    return absoluteTimeout === undefined
      ? undefined
      : authTime + absoluteTimeout
  }

  const signAccessToken = async (claims: {
    sub: string
    username?: string
    auth_time: number
    client_id?: string
    sid: string
  }): Promise<CreatedAccessToken> => {
    const { signingKey, kid } = await getKeys()
    const accessTokenId = crypto.randomUUID()
    const issuedAt = nowInSeconds()
    // An access token never outlives its session.
    const expiresAt = Math.min(
      issuedAt + settings.accessTokenTTL,
      sessionEnd(claims.auth_time, claims.client_id) ?? Infinity
    )

    const token = await new SignJWT({
      // Personal data: written on demand only.
      ...(settings.usernameClaim &&
        claims.username && { username: claims.username }),
      auth_time: claims.auth_time,
      sid: claims.sid,
      ...(claims.client_id !== undefined && { client_id: claims.client_id }),
    })
      .setProtectedHeader({ alg: ALGORITHM, typ: ACCESS_TOKEN_TYPE, kid })
      .setSubject(claims.sub)
      .setIssuer(settings.issuer)
      .setAudience(settings.audience)
      .setJti(accessTokenId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(signingKey)

    return {
      accessTokenId,
      accessToken: token,
      expiresAt: new Date(expiresAt * 1000),
    }
  }

  const generateRefreshToken = async (): Promise<CreatedRefreshToken> => {
    const token = toHex(crypto.getRandomValues(new Uint8Array(128)))
    return { token, tokenHash: await sha256(token) }
  }

  /**
   * Signs an access token and stores a new refresh token. The refresh
   * token expires after the inactivity timeout, or at the end of the
   * session.
   */
  const issueTokens = async (
    claims: {
      sub: string
      username?: string
      auth_time: number
      client_id?: string
    },
    sessionId: string
  ): Promise<IssuedTokens> => {
    // Every token of a session shares its identifier (`sid`).
    const access = await signAccessToken({ ...claims, sid: sessionId })
    const refreshToken = await generateRefreshToken()
    const end = sessionEnd(claims.auth_time, claims.client_id)
    const refreshTokenExpiresAt = new Date(
      Math.min(
        Date.now() + sessionPolicy(claims.client_id).idleTimeout * 1000,
        end === undefined ? Infinity : end * 1000
      )
    )

    await settings.dataProvider.storeRefreshToken({
      tokenHash: refreshToken.tokenHash,
      userId: claims.sub,
      accessTokenId: access.accessTokenId,
      sessionId,
      expiresAt: refreshTokenExpiresAt,
    })

    return {
      accessToken: access.accessToken,
      refreshToken: refreshToken.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshTokenExpiresAt,
      sessionExpiresAt: end === undefined ? undefined : new Date(end * 1000),
    }
  }

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

    const sessionId = stored.sessionId ?? undefined
    if (sessionId) {
      await settings.dataProvider.revokeSessionTokens(sessionId)
    } else {
      // Tokens stored before sessions (V1): revoke every session of the user.
      await settings.dataProvider.revokeUserTokens(stored.userId)
    }

    try {
      await settings.onRefreshTokenReuse?.({
        userId: stored.userId,
        sessionId,
        accessTokenId: stored.accessTokenId,
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

  /** Claims of a new session, for trusted code (login, scripts). */
  const sessionClaims = ({ userId, username, clientId }: TokenSubject) => {
    if (!isClientAccepted(clientId)) {
      throw new TypeError(
        clientId === undefined
          ? 'A clientId is required by the clients setting.'
          : `Unknown client "${clientId}": add it to clients.allowed.`
      )
    }
    return {
      sub: userId,
      username,
      auth_time: nowInSeconds(),
      client_id: clientId,
    }
  }

  let routesPath: string | undefined
  let cors: PluginCors | undefined

  /** Trusted origins: `cookies.trustedOrigins`, else the CORS origins. */
  const isTrustedOrigin = (req: DotpressRequest) => (origin: string) => {
    if (input.cookies?.trustedOrigins !== undefined || !cors?.credentials) {
      return settings.cookies.trustedOrigins.includes(origin)
    }
    return cors.isOriginAllowed(req)
  }

  /**
   * Sets the path of the refresh token cookie to the browser path of the
   * auth routes, unless `cookies.refreshTokenPath` is set.
   */
  const bindRoutesPath = (path: string) => {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new TypeError(
        `Invalid routesPath: expected a path starting with "/", received ${JSON.stringify(path)}.`
      )
    }
    if (routesPath !== undefined && routesPath !== path) {
      throw new Error(
        `This auth service already serves routes under "${routesPath}": create one auth service per app to serve them under "${path}".`
      )
    }
    routesPath = path
    if (input.cookies?.refreshTokenPath === undefined) {
      settings.cookies = resolveCookies({
        ...input.cookies,
        refreshTokenPath: path,
      })
    }
  }

  const cookieOptions = () => {
    const { httpOnly, secure, sameSite, path, domain } = settings.cookies
    return { httpOnly, secure, sameSite, path, domain }
  }

  const auth: Auth = {
    isCookieAuthenticationAllowed: (req) =>
      isCookieAuthenticationAllowed(req, isTrustedOrigin(req)),

    async generateTokensForUser(subject) {
      return issueTokens(sessionClaims(subject), crypto.randomUUID())
    },

    async refreshTokens({ accessToken, refreshToken }) {
      const { verificationKeys } = await getKeys()

      let claims: Record<string, unknown>
      let legacy: boolean
      try {
        // Signature only: the access token is usually expired here, and
        // `iss`, `aud` and `typ` are not checked, so that tokens issued
        // by V1 (or before a configuration change) are migrated. The
        // stored refresh token proves the session.
        const { payload, protectedHeader } = await verifyWithKeys(
          accessToken,
          verificationKeys,
          (key) => compactVerify(accessToken, key, { algorithms: [ALGORITHM] })
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
        stored.accessTokenId !== claims.jti ||
        stored.revokedAt ||
        // Client removed from the configuration: the session ends.
        !isClientAccepted(clientId)
      ) {
        throw new AuthError('INVALID_REFRESH_TOKEN')
      }

      if (stored.isUsed) await checkReuse(stored)

      // Start of the session, kept across rotations. Without it, a
      // session cannot be bounded: with an absolute timeout, it ends.
      const claimedAuthTime =
        typeof claims.auth_time === 'number' ? claims.auth_time : undefined
      if (
        claimedAuthTime === undefined &&
        sessionPolicy(clientId).absoluteTimeout !== undefined
      ) {
        throw new AuthError('EXPIRED_REFRESH_TOKEN')
      }
      const authTime = claimedAuthTime ?? nowInSeconds()
      const end = sessionEnd(authTime, clientId)

      // Inactivity timeout (refresh token expiry) and absolute timeout.
      if (
        stored.expiresAt.getTime() <= Date.now() ||
        (end !== undefined && end * 1000 <= Date.now())
      ) {
        throw new AuthError('EXPIRED_REFRESH_TOKEN')
      }

      // Deleted or disabled account: the session ends.
      const user = await settings.dataProvider.findUserById(userId)
      if (!user) {
        if (stored.sessionId) {
          await settings.dataProvider.revokeSessionTokens(stored.sessionId)
        } else {
          await settings.dataProvider.revokeUserTokens(userId)
        }
        throw new AuthError('INVALID_REFRESH_TOKEN')
      }

      const issued = await issueTokens(
        {
          sub: userId,
          username:
            typeof claims.username === 'string' ? claims.username : undefined,
          auth_time: authTime,
          client_id: clientId,
        },
        // Tokens stored before sessions (V1) start one, derived from the
        // token so that concurrent rotations land in the same session.
        stored.sessionId || stored.accessTokenId
      )
      // A token reused within the interval keeps its first use date: the
      // interval cannot be extended by presenting it again.
      if (!stored.isUsed) {
        await settings.dataProvider.markRefreshTokenAsUsed(
          refreshTokenHash,
          new Date()
        )
      }

      return { userId, user, ...issued }
    },

    async verifyAccessToken(accessToken) {
      const { verificationKeys } = await getKeys()
      try {
        const { payload } = await verifyWithKeys(
          accessToken,
          verificationKeys,
          (key) =>
            jwtVerify(accessToken, key, {
              algorithms: [ALGORITHM],
              typ: ACCESS_TOKEN_TYPE,
              issuer: settings.issuer,
              audience: settings.audience,
            })
        )
        const session = toSession(payload as Record<string, unknown>, [])
        if (!isClientAccepted(session.clientId)) {
          throw new AuthError('INVALID_ACCESS_TOKEN')
        }
        const { isSessionRevoked } = settings.dataProvider
        if (
          session.sessionId !== undefined &&
          isSessionRevoked &&
          (await isSessionRevoked.call(
            settings.dataProvider,
            session.sessionId
          ))
        ) {
          throw new AuthError('SESSION_REVOKED')
        }
        return session
      } catch (error) {
        if (error instanceof AuthError) throw error
        throw new AuthError('INVALID_ACCESS_TOKEN', { cause: error })
      }
    },

    async revokeSession(refreshToken, { scope = 'current' } = {}) {
      const { dataProvider } = settings
      const stored = await dataProvider.findRefreshToken(
        await sha256(refreshToken)
      )
      if (!stored) return undefined
      const sessionId = stored.sessionId || undefined

      if (scope === 'all') {
        // Logging out every device requires a token that still works.
        if (
          stored.revokedAt ||
          stored.isUsed ||
          stored.expiresAt.getTime() <= Date.now()
        ) {
          return undefined
        }
        await dataProvider.revokeUserTokens(stored.userId)
      } else if (sessionId) {
        await dataProvider.revokeSessionTokens(sessionId)
      } else {
        // Token stored before sessions (V1): its session cannot be singled out.
        await dataProvider.revokeUserTokens(stored.userId)
      }

      return { userId: stored.userId, sessionId }
    },

    async revokeUserSessions(userId) {
      if (typeof userId !== 'string' || userId === '') {
        throw new TypeError('revokeUserSessions() requires a userId.')
      }
      await settings.dataProvider.revokeUserTokens(userId)
    },

    async getJwks() {
      const { verificationKeys } = await getKeys()
      return {
        keys: verificationKeys.map(({ kid, jwk }) => ({
          ...jwk,
          kid,
          alg: ALGORITHM,
          use: 'sig',
        })),
      }
    },

    getSessionExpiresAt(session) {
      const authTime = session.claims.auth_time
      if (typeof authTime !== 'number') return undefined
      const end = sessionEnd(authTime, session.clientId)
      return end === undefined ? undefined : new Date(end * 1000)
    },

    getUserRoles: (user) => settings.getUserRoles(user),

    setAuthCookies(res, tokens) {
      const cookies = settings.cookies
      if (!cookies.enabled) return

      // Both cookies live as long as the refresh token: refreshing requires
      // the access token, even expired (its claims and signature).
      const expiresAt = tokens.refreshTokenExpiresAt?.getTime()
      const options = {
        ...cookieOptions(),
        maxAge:
          expiresAt === undefined
            ? settings.session.idleTimeout
            : Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
      }

      res.setCookie(cookies.refreshTokenName, tokens.refreshToken, {
        ...options,
        path: cookies.refreshTokenPath,
        sameSite: cookies.refreshTokenSameSite,
      })
      if (cookies.accessTokenInCookie) {
        res.setCookie(cookies.accessTokenName, tokens.accessToken, options)
      }
    },

    clearAuthCookies(res) {
      const cookies = settings.cookies
      if (!cookies.enabled) return

      // A cookie is only cleared with its path.
      res.clearCookie(cookies.refreshTokenName, {
        ...cookieOptions(),
        path: cookies.refreshTokenPath,
      })
      if (cookies.accessTokenInCookie) {
        res.clearCookie(cookies.accessTokenName, cookieOptions())
      }
    },

    hashPassword: (password) =>
      generatePasswordHash(password, { rounds: settings.passwordHashRounds }),

    passwordNeedsRehash: (passwordHash) =>
      BCRYPT_HASH.test(passwordHash) &&
      bcrypt.getRounds(passwordHash) !== settings.passwordHashRounds,

    // No length check: the password was verified, and a longer V1 password
    // is truncated the same way.
    rehashPassword: (password) =>
      bcrypt.hash(password, settings.passwordHashRounds),

    async verifyPassword(password, passwordHash) {
      if (typeof passwordHash === 'string' && BCRYPT_HASH.test(passwordHash)) {
        return bcrypt.compare(password, passwordHash)
      }
      await bcrypt.compare(password, await getDummyHash())
      return false
    },
  }

  internals.set(auth, {
    settings,
    init: async (options = {}) => {
      if (options.routesPath !== undefined) bindRoutesPath(options.routesPath)
      if (options.cors !== undefined) cors = options.cors
      // The dummy hash is computed now: otherwise, the first login of an
      // unknown user would take longer.
      await Promise.all([getKeys(), getDummyHash()])
    },
  })
  return auth
}

/** Longest password bcrypt reads, in UTF-8 bytes. */
const MAX_PASSWORD_BYTES = 72

/**
 * Whether a password exceeds the 72 bytes (UTF-8) read by bcrypt. Check
 * it in the sign-up and password change schemas: `hashPassword()` rejects
 * these passwords instead of silently truncating them.
 *
 * @example
 * password: z.string().min(12).refine((p) => !isPasswordTooLong(p), 'Password too long')
 */
export const isPasswordTooLong = (password: string): boolean =>
  bcrypt.truncates(password)

export interface PasswordHashOptions {
  /** bcrypt cost, from 4 to 31. Defaults to 12. */
  rounds?: number
}

/**
 * Hashes a password with bcrypt, out of an auth service (seeds, scripts).
 * Throws a `RangeError` for passwords longer than 72 bytes (see
 * `isPasswordTooLong()`).
 */
export const generatePasswordHash = async (
  password: string,
  options: PasswordHashOptions = {}
): Promise<string> => {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('generatePasswordHash(): options must be an object.')
  }
  for (const key of Object.keys(options)) {
    if (key !== 'rounds') {
      throw new TypeError(`generatePasswordHash(): unknown option "${key}".`)
    }
  }
  const { rounds = 12 } = options
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 31) {
    throw new RangeError(
      'generatePasswordHash(): rounds must be an integer between 4 and 31.'
    )
  }
  if (isPasswordTooLong(password)) {
    throw new RangeError(
      `Password too long: bcrypt reads ${MAX_PASSWORD_BYTES} bytes at most (UTF-8). Check it with isPasswordTooLong().`
    )
  }
  return bcrypt.hash(password, rounds)
}
