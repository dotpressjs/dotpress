import type {
  DotpressRequest,
  Duration,
  HttpError,
  PluginCors,
  RateLimitStore,
} from '@dotpress/core'

/**
 * Authenticated user, as returned by `DataProvider.findUserById()`.
 * Declare its shape through module augmentation:
 *
 * @example
 * declare module '@dotpress/auth' {
 *   interface AuthUser {
 *     id: string
 *     roles: string[]
 *   }
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- completed by module augmentation
export interface AuthUser {}

/**
 * Data of the access token of the current request.
 */
export interface AuthSession {
  readonly userId: string
  /** `username` claim, with the `usernameClaim` setting only. */
  readonly username: string | undefined
  /** Identifier of the access token (`jti` claim), stored with its refresh token. */
  readonly accessTokenId: string
  /**
   * Session of the token (`sid` claim): shared by the tokens rotated from
   * the same login.
   */
  readonly sessionId: string
  /** Client the token was issued for (`client_id` claim). */
  readonly clientId: string | undefined
  /** Roles of the user, used by `requireRole()`. */
  readonly roles: readonly string[]
  /** Decoded token claims. */
  readonly claims: Readonly<Record<string, unknown>>
}

export interface KeyPairOptions {
  /** RSA private key, PEM encoded in PKCS#8 (`BEGIN PRIVATE KEY`). */
  privateKey: string
  /** RSA public key, PEM encoded in SPKI (`BEGIN PUBLIC KEY`). */
  publicKey: string
  /**
   * Key identifier (`kid` header of the tokens). Defaults to the RFC 7638
   * thumbprint of the public key.
   */
  kid?: string
  /**
   * Other public keys accepted to verify tokens (SPKI PEM, with an optional
   * `kid`, defaulting to their thumbprint): the previous key after a
   * rotation, or the next key before it, during rolling deployments.
   */
  additionalPublicKeys?: readonly (string | AdditionalPublicKey)[]
}

export interface AdditionalPublicKey {
  publicKey: string
  kid?: string
}

export interface AuthCookieOptions {
  /** Enables cookie mode. Defaults to `false`. */
  enabled?: boolean
  /** Defaults to `true`. */
  httpOnly?: boolean
  /** Defaults to `true` (browsers accept secure cookies on `localhost`). */
  secure?: boolean
  /** Defaults to `lax`. */
  sameSite?: 'strict' | 'lax' | 'none'
  /**
   * `SameSite` attribute of the refresh token cookie, which never needs to
   * accompany a navigation from another site. Defaults to `strict`, or to
   * `none` when `sameSite` is `none`.
   */
  refreshTokenSameSite?: 'strict' | 'lax' | 'none'
  /**
   * Origins allowed to send requests authenticated by the cookies, besides
   * the API origin: for example `https://app.example.com` when the app is
   * served from another subdomain. Other cross-origin requests do not use
   * the cookies (protection against cross-site request forgery).
   *
   * Defaults to the origins allowed by the `cors` option of the app, when
   * it allows credentials (`authPlugin()`), else to none.
   */
  trustedOrigins?: readonly string[]
  domain?: string
  /** Path of the access token cookie. Defaults to `/`. */
  path?: string
  /**
   * Path of the refresh token cookie: the browser path of the auth routes,
   * the only ones that need it. With `authPlugin()`, defaults to the path
   * of its routes, including the `basePath` or `publicBasePath` of the app
   * (for example `/my-app/api/auth`). Defaults to `/auth` otherwise.
   */
  refreshTokenPath?: string
  /**
   * Defaults to `dotpress_access_token`, prefixed with `__Host-` when the
   * cookie is secure, without domain and with path `/`, or with
   * `__Secure-` when it is only secure.
   */
  accessTokenName?: string
  /**
   * Defaults to `dotpress_refresh_token`, prefixed like the access token
   * cookie (`__Secure-` with the default path).
   */
  refreshTokenName?: string
  /** Also stores the access token in a cookie. Defaults to `false`. */
  accessTokenInCookie?: boolean
}

export type ResolvedCookieOptions = Required<
  Omit<AuthCookieOptions, 'domain'>
> & {
  domain: string | undefined
}

/** Why a login failed. */
export type LoginErrorType =
  | 'invalid_username'
  | 'invalid_password'
  | 'invalid_role'
  /** Blocked by the login throttle, before checking the password. */
  | 'too_many_attempts'

export interface LoginFailedEvent {
  username: string
  errorType: LoginErrorType
  /** `clientId` sent at login; empty when missing. */
  clientId: string
  ipAddress: string
}

/** Login attempt, before the password is checked. */
export interface BeforeLoginEvent {
  username: string
  /** `clientId` sent at login; empty when missing. */
  clientId: string
  ipAddress: string
  req: DotpressRequest
}

/** At most `max` failed logins per `window`. */
export interface RateLimit {
  max: number
  /** A number of seconds, or a duration like `'1m'` or `'1h'`. */
  window: Duration
}

/** A rate limit, with its window in seconds. */
export interface ResolvedRateLimit {
  max: number
  window: number
}

/**
 * Login throttle: failed logins are counted per username and IP address,
 * and per username, whether the account exists or not.
 */
export interface LoginThrottleOptions {
  /**
   * Counters storage. Defaults to an in-memory store, for a single
   * instance: use a shared store (Redis, database) with several instances.
   */
  store?: RateLimitStore
  limits?: {
    /**
     * Against brute force from one client, without letting others block
     * the account. Defaults to 5 per minute; `false` disables it.
     */
    usernameAndIp?: RateLimit | false
    /**
     * Against distributed brute force on an account. Defaults to 100 per
     * hour (NIST 800-63B); `false` disables it.
     */
    username?: RateLimit | false
  }
}

export interface ResolvedLoginThrottleOptions {
  store: RateLimitStore
  limits: {
    usernameAndIp: ResolvedRateLimit | undefined
    username: ResolvedRateLimit | undefined
  }
}

export interface RefreshTokenReuseEvent {
  userId: string
  /** Revoked session; undefined for tokens stored before sessions (V1). */
  sessionId: string | undefined
  /** `jti` of the access token the reused refresh token was issued with. */
  accessTokenId: string
}

export interface LoginSuccessEvent {
  userId: string
  username: string
  /** `clientId` sent at login; empty when missing. */
  clientId: string
  ipAddress: string
}

/**
 * Refresh token to store. The token itself is never given: only its
 * SHA-256 hash, which `findRefreshToken()` receives.
 */
export interface NewRefreshToken {
  tokenHash: string
  userId: string
  /** `jti` of the access token issued with the refresh token. */
  accessTokenId: string
  /**
   * Session the token belongs to: created at login, kept by every
   * rotation. Used to revoke the whole session when a token is reused.
   */
  sessionId: string
  expiresAt: Date
}

/**
 * Sessions revoked by a logout: the current session, or every session of
 * the user.
 */
export type LogoutScope = 'current' | 'all'

/** Session revoked by `revokeSession()`. */
export interface RevokedSession {
  userId: string
  /** `undefined` for tokens stored before sessions (V1). */
  sessionId: string | undefined
}

export interface RefreshTokenData {
  userId: string
  accessTokenId: string
  /** `null` or missing for tokens stored before sessions (V1). */
  sessionId?: string | null
  expiresAt: Date
  isUsed: boolean
  /** When the token was used (see `refreshTokenReuseInterval`). */
  usedAt?: Date | null
  revokedAt?: Date | null
}

export interface UserIdentifiers {
  userId: string
  /**
   * bcrypt hash of the password. `null` (or an empty string) for accounts
   * without password (SSO, pending invitation): their login fails like a
   * wrong password, in the same time.
   */
  passwordHash: string | null
  role?: string
}

/**
 * Storage of users and refresh tokens, implemented by the application
 * (Prisma, Drizzle, SQL…).
 */
export interface DataProvider {
  storeRefreshToken(payload: NewRefreshToken): Promise<void>
  findRefreshToken(tokenHash: string): Promise<RefreshTokenData | undefined>
  /** Marks a token as used, storing `usedAt`. */
  markRefreshTokenAsUsed(tokenHash: string, usedAt: Date): Promise<void>
  /** Revokes every refresh token of a user. */
  revokeUserTokens(userId: string): Promise<void>
  /** Revokes every refresh token of a session. */
  revokeSessionTokens(sessionId: string): Promise<void>
  /**
   * User of a token, on every authenticated request and every refresh.
   * Return `undefined` for a deleted, disabled or banned account: its
   * requests are rejected at once, and its sessions end at their next
   * refresh.
   */
  findUserById(userId: string): Promise<AuthUser | undefined>
  findUserIdentifiers(username: string): Promise<UserIdentifiers | undefined>
  /**
   * Optional. Whether a session (the `sid` claim) was revoked.
   * When defined, it is checked on every authenticated request, so that
   * the access tokens of a revoked session (logout, refresh token reuse,
   * password change) stop working at once, instead of at their expiry.
   * It costs one lookup per request: see the README for implementations.
   */
  isSessionRevoked?(sessionId: string): Promise<boolean>
  /**
   * Optional. Stores a new hash of the password of a user, computed at
   * login when the stored hash has another cost than `passwordHashRounds`
   * (for example after raising it). Errors are logged, and do not fail
   * the login.
   */
  updatePasswordHash?(userId: string, passwordHash: string): Promise<void>
}

/**
 * Client applications (`client_id` claim), such as `app` or `backoffice`.
 *
 * The client identifier is declared by the caller at login: it does not
 * prove which application sends a request. It means that the token was
 * issued under the policy of that client (see `isUserRoleAllowed`).
 */
export interface ClientOptions {
  /** Accepted client identifiers. Others are rejected at login (`400`). */
  allowed: readonly string[]
  /** Requires a `clientId` at login. Defaults to `false`. */
  required?: boolean
  /** Checks at login that a user may get a token for a client. */
  isUserRoleAllowed?: (login: {
    userId: string
    /** `role` of `findUserIdentifiers()`. */
    role: string | undefined
    clientId: string
  }) => boolean
  /**
   * Session lifetimes of some clients, overriding the `session` setting
   * (an explicit `absoluteTimeout: undefined` removes the global limit).
   *
   * @example
   * sessions: { backoffice: { idleTimeout: '1d', absoluteTimeout: '1d' } }
   */
  sessions?: Readonly<Record<string, SessionOptions>>
}

/**
 * Session lifetimes: numbers of seconds, or durations like `'14d'`. A
 * session starts at login and is extended by each refresh.
 */
export interface SessionOptions {
  /**
   * Inactivity timeout: the session ends when it is not refreshed during
   * this delay (lifetime of each refresh token). Defaults to 14 days.
   */
  idleTimeout?: Duration
  /**
   * Absolute timeout: the session ends this delay after login, even when
   * it is active. Defaults to none: active sessions never end.
   */
  absoluteTimeout?: Duration | undefined
}

export interface ResolvedSessionOptions {
  idleTimeout: number
  absoluteTimeout: number | undefined
}

export interface AuthOptions {
  keys: KeyPairOptions
  dataProvider: DataProvider
  /**
   * Access token lifetime: a number of seconds, or a duration like `'15m'`.
   * Defaults to 15 minutes: the longest delay during which the token of a
   * revoked session still works, without `DataProvider.isSessionRevoked()`.
   */
  accessTokenTTL?: Duration
  /** Session lifetimes (inactivity and absolute timeouts). */
  session?: SessionOptions
  /**
   * `iss` claim of the access tokens, checked on every request: for
   * example the URL of the API. Use a different value per environment
   * and application, especially when they share a key pair.
   */
  issuer: string
  /**
   * `aud` claim of the access tokens: the API that accepts them, checked
   * on every request. Defaults to `issuer`.
   */
  audience?: string
  cookies?: AuthCookieOptions
  clients?: ClientOptions
  onLoginFailed?: (event: LoginFailedEvent) => void | Promise<void>
  onLoginSuccess?: (event: LoginSuccessEvent) => void | Promise<void>
  /**
   * Login throttle (brute force protection), enabled by default. `false`
   * disables it, when the infrastructure (gateway, WAF) already limits
   * `/auth/login`.
   */
  loginThrottle?: LoginThrottleOptions | false
  /**
   * Called before checking the password, after the login throttle: return
   * an error (`tooManyRequestsError()`, `forbiddenError()`…) to reject the
   * attempt, for example to require a CAPTCHA or to block an IP address.
   */
  beforeLogin?: (
    event: BeforeLoginEvent
  ) => Promise<HttpError | void> | HttpError | void
  /**
   * bcrypt cost of `hashPassword()`, and of the dummy hash compared when
   * the user is unknown or has no password, so that every login takes the
   * same time. Hashes with another cost are upgraded at login when
   * `DataProvider.updatePasswordHash()` is defined. Defaults to 12.
   */
  passwordHashRounds?: number
  /**
   * Writes the `username` claim in the access tokens. Defaults to `false`:
   * a username is often an email address, readable by anyone holding the
   * token (it is only base64 encoded); `sub` identifies the user.
   */
  usernameClaim?: boolean
  /**
   * Delay after its first use during which a refresh token can be
   * presented again without being treated as stolen: concurrent refreshes
   * (several tabs) and retries after a lost response get a new token pair
   * in the same session. A number of seconds, or a duration like `'10s'`.
   * Defaults to 10 seconds; 0 disables it.
   */
  refreshTokenReuseInterval?: Duration
  /**
   * Called when a used refresh token is presented again after the reuse
   * interval: the session has been revoked, as the token was probably
   * stolen. Errors thrown by the hook are ignored.
   */
  onRefreshTokenReuse?: (event: RefreshTokenReuseEvent) => void | Promise<void>
  /**
   * Roles of a user, checked by `requireRole()`. Defaults to its `roles`
   * array, or to its `role` string.
   */
  getUserRoles?: (user: AuthUser) => readonly string[]
}

/** Options of the setup of an auth service by `authPlugin()`. */
export interface AuthInitOptions {
  /**
   * Browser path of the auth routes, used as the default path of the
   * refresh token cookie. An auth service serves a single path.
   */
  routesPath?: string
  /**
   * CORS settings of the app (`api.cors`). When `cookies.trustedOrigins`
   * is not set and CORS allows credentials, the origins allowed by CORS
   * are trusted.
   */
  cors?: PluginCors
}

export interface ResolvedAuthOptions extends Required<
  Omit<
    AuthOptions,
    | 'cookies'
    | 'clients'
    | 'session'
    | 'onLoginFailed'
    | 'onLoginSuccess'
    | 'loginThrottle'
    | 'beforeLogin'
    | 'onRefreshTokenReuse'
    | 'accessTokenTTL'
    | 'refreshTokenReuseInterval'
  >
> {
  /** In seconds. */
  accessTokenTTL: number
  /** In seconds. */
  refreshTokenReuseInterval: number
  /** Session lifetimes of the clients, in seconds. */
  clientSessions: Readonly<Record<string, Partial<ResolvedSessionOptions>>>
  cookies: ResolvedCookieOptions
  clients: ClientOptions | undefined
  session: ResolvedSessionOptions
  onLoginFailed: AuthOptions['onLoginFailed']
  onLoginSuccess: AuthOptions['onLoginSuccess']
  loginThrottle: ResolvedLoginThrottleOptions | undefined
  beforeLogin: AuthOptions['beforeLogin']
  onRefreshTokenReuse: AuthOptions['onRefreshTokenReuse']
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export interface TokenSubject {
  userId: string
  /** Written in the token with the `usernameClaim` setting only. */
  username?: string
  /** `client_id` claim. Must be allowed by the `clients` setting. */
  clientId?: string
}

/** Token pair issued at login or by a refresh. */
export interface IssuedTokens extends TokenPair {
  accessTokenExpiresAt: Date
  refreshTokenExpiresAt: Date
  /** End of the session, when an absolute timeout applies. */
  sessionExpiresAt: Date | undefined
}

/** Access token signed by the service. */
export interface CreatedAccessToken {
  accessTokenId: string
  accessToken: string
  expiresAt: Date
}

export interface CreatedRefreshToken {
  token: string
  tokenHash: string
}
