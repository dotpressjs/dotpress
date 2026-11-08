import type { DotpressRequest, HttpError } from '@dotpress/core'
import type { RateLimitStore } from './rate-limit.js'

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
  readonly username: string
  /** Token identifier (`jti`), shared with its refresh token. */
  readonly tokenId: string
  /** Client the token was issued for (`client_id` claim). */
  readonly clientId: string | undefined
  /** Roles of the user, used by `requireRole()`. */
  readonly roles: readonly string[]
  /** Decoded token claims. */
  readonly claims: Readonly<Record<string, unknown>>
}

export interface KeyPairSettings {
  /** RSA private key, PEM encoded in PKCS#8 (`BEGIN PRIVATE KEY`). */
  secretKey: string
  /** RSA public key, PEM encoded in SPKI (`BEGIN PUBLIC KEY`). */
  publicKey: string
}

export interface CookieSettings {
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
   */
  trustedOrigins?: readonly string[]
  domain?: string
  /** Defaults to `/`. */
  path?: string
  /** Defaults to `dotpress_access_token`. */
  accessTokenName?: string
  /** Defaults to `dotpress_refresh_token`. */
  refreshTokenName?: string
  /** Also stores the access token in a cookie. Defaults to `false`. */
  accessTokenInCookie?: boolean
}

export type ResolvedCookieSettings = Required<
  Omit<CookieSettings, 'domain'>
> & {
  domain: string | undefined
}

export interface LoginFailedEvent {
  username: string
  errorType:
    | 'invalid_username'
    | 'invalid_password'
    | 'invalid_role'
    /** Blocked by the login throttle, before checking the password. */
    | 'too_many_attempts'
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

/** At most `max` failed logins per `window` seconds. */
export interface RateLimit {
  max: number
  window: number
}

/**
 * Login throttle: failed logins are counted per username and IP address,
 * and per username, whether the account exists or not.
 */
export interface LoginThrottleSettings {
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

export interface ResolvedLoginThrottleSettings {
  store: RateLimitStore
  limits: {
    usernameAndIp: RateLimit | undefined
    username: RateLimit | undefined
  }
}

export interface RefreshTokenReuseEvent {
  userId: string
  /** Revoked session; undefined for tokens stored without family. */
  familyId: string | undefined
  /** `jti` of the access token the reused refresh token was issued with. */
  jwtId: string
}

export interface LoginSuccessEvent {
  userId: string
  username: string
  /** `clientId` sent at login; empty when missing. */
  clientId: string
  ipAddress: string
}

export interface StoreRefreshTokenDto {
  token: string
  tokenHash: string
  userId: string
  jwtId: string
  /**
   * Session the token belongs to: created at login, kept by every
   * rotation. Used to revoke the whole session when a token is reused.
   */
  familyId: string
  expiresAt: Date
}

export interface RefreshTokenData {
  userId: string
  jwtId: string
  /** `null` or missing for tokens stored before families existed. */
  familyId?: string | null
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
  storeRefreshToken(payload: StoreRefreshTokenDto): Promise<void>
  findRefreshToken(tokenHash: string): Promise<RefreshTokenData | undefined>
  /** Marks a token as used, storing `usedAt`. */
  markRefreshTokenAsUsed(tokenHash: string, usedAt: Date): Promise<void>
  /** Revokes every refresh token of a user. */
  revokeTokens(userId: string): Promise<void>
  /** Revokes every refresh token of a session (`familyId`). */
  revokeTokenFamily(familyId: string): Promise<void>
  findUserById(userId: string): Promise<AuthUser | undefined>
  findUserIdentifiers(username: string): Promise<UserIdentifiers | undefined>
}

/**
 * Client applications (`client_id` claim), such as `app` or `backoffice`.
 *
 * The client identifier is declared by the caller at login: it does not
 * prove which application sends a request. It means that the token was
 * issued under the policy of that client (see `isUserRoleAllowed`).
 */
export interface ClientSettings {
  /** Accepted client identifiers. Others are rejected at login (`400`). */
  allowed: readonly string[]
  /** Requires a `clientId` at login. Defaults to `false`. */
  required?: boolean
  /** Checks at login that a user may get a token for a client. */
  isUserRoleAllowed?: (role: string, clientId: string) => boolean
  /**
   * Session lifetimes of some clients, overriding the `session` setting
   * (an explicit `absoluteTimeout: undefined` removes the global limit).
   *
   * @example
   * sessions: { backoffice: { idleTimeout: 86400, absoluteTimeout: 86400 } }
   */
  sessions?: Readonly<Record<string, SessionSettings>>
}

/**
 * Session lifetimes, in seconds. A session starts at login and is extended
 * by each refresh.
 */
export interface SessionSettings {
  /**
   * Inactivity timeout: the session ends when it is not refreshed during
   * this delay (lifetime of each refresh token). Defaults to 14 days.
   */
  idleTimeout?: number
  /**
   * Absolute timeout: the session ends this delay after login, even when
   * it is active. Defaults to none: active sessions never end.
   */
  absoluteTimeout?: number | undefined
}

export interface ResolvedSessionSettings {
  idleTimeout: number
  absoluteTimeout: number | undefined
}

export interface AuthSettings {
  keys: KeyPairSettings
  dataProvider: DataProvider
  /** Access token lifetime, in seconds. Defaults to 3600. */
  accessTokenTTL?: number
  /** Session lifetimes (inactivity and absolute timeouts). */
  session?: SessionSettings
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
  cookies?: CookieSettings
  clients?: ClientSettings
  onLoginFailed?: (event: LoginFailedEvent) => Promise<void>
  onLoginSuccess?: (event: LoginSuccessEvent) => Promise<void>
  /**
   * Login throttle (brute force protection), enabled by default. `false`
   * disables it, when the infrastructure (gateway, WAF) already limits
   * `/auth/login`.
   */
  loginThrottle?: LoginThrottleSettings | false
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
   * same time. Set it to the cost of the hashes stored in the database.
   * Defaults to 10.
   */
  passwordHashRounds?: number
  /**
   * Delay, in seconds after its first use, during which a refresh token can
   * be presented again without being treated as stolen: concurrent
   * refreshes (several tabs) and retries after a lost response get a new
   * token pair in the same session. Defaults to 10; 0 disables it.
   */
  refreshTokenReuseInterval?: number
  /**
   * Called when a used refresh token is presented again after the reuse
   * interval: the session has been revoked, as the token was probably
   * stolen. Errors thrown by the hook are ignored.
   */
  onRefreshTokenReuse?: (event: RefreshTokenReuseEvent) => Promise<void>
  /**
   * Roles of a user, checked by `requireRole()`. Defaults to its `roles`
   * array, or to its `role` string.
   */
  getUserRoles?: (user: AuthUser) => readonly string[]
}

export interface ResolvedAuthSettings extends Required<
  Omit<
    AuthSettings,
    | 'cookies'
    | 'clients'
    | 'session'
    | 'onLoginFailed'
    | 'onLoginSuccess'
    | 'loginThrottle'
    | 'beforeLogin'
    | 'onRefreshTokenReuse'
  >
> {
  cookies: ResolvedCookieSettings
  clients: ClientSettings | undefined
  session: ResolvedSessionSettings
  onLoginFailed: ((event: LoginFailedEvent) => Promise<void>) | undefined
  onLoginSuccess: ((event: LoginSuccessEvent) => Promise<void>) | undefined
  loginThrottle: ResolvedLoginThrottleSettings | undefined
  beforeLogin: AuthSettings['beforeLogin']
  onRefreshTokenReuse:
    ((event: RefreshTokenReuseEvent) => Promise<void>) | undefined
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export interface TokenSubject {
  userId: string
  username: string
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

export interface CreatedAccessToken {
  jwtId: string
  accessToken: string
  expiresAt: Date
}

export interface CreatedRefreshToken {
  token: string
  tokenHash: string
}
