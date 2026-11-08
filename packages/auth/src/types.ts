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
  readonly audience: string | undefined
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
  errorType: 'invalid_username' | 'invalid_password' | 'invalid_role'
  client: string
  ipAddress: string
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
  client: string
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

export interface AudienceSettings {
  /** Requires an `aud` field at login. */
  required?: boolean
  isUserRoleAllowed(role: string, aud: string): boolean
}

export interface AuthSettings {
  keys: KeyPairSettings
  dataProvider: DataProvider
  /** Access token lifetime, in seconds. Defaults to 3600. */
  accessTokenTTL?: number
  /** Refresh token lifetime, in days. Defaults to 14. */
  refreshTokenTTLInDays?: number
  /** `iss` claim of the access tokens. Defaults to an empty string. */
  issuer?: string
  cookies?: CookieSettings
  aud?: AudienceSettings
  onLoginFailed?: (event: LoginFailedEvent) => Promise<void>
  onLoginSuccess?: (event: LoginSuccessEvent) => Promise<void>
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
    | 'aud'
    | 'onLoginFailed'
    | 'onLoginSuccess'
    | 'onRefreshTokenReuse'
  >
> {
  cookies: ResolvedCookieSettings
  aud: AudienceSettings | undefined
  onLoginFailed: ((event: LoginFailedEvent) => Promise<void>) | undefined
  onLoginSuccess: ((event: LoginSuccessEvent) => Promise<void>) | undefined
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
  aud?: string
}

export interface CreatedAccessToken {
  jwtId: string
  accessToken: string
}

export interface CreatedRefreshToken {
  token: string
  tokenHash: string
}
