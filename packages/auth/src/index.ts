import './context.js'

export {
  AuthError,
  createAuth,
  generatePasswordHash,
  isPasswordTooLong,
  type Auth,
  type AuthErrorCode,
  type PasswordHashOptions,
} from './auth.js'

export {
  requireAuth,
  requireClient,
  requireRole,
  type AuthenticatedContext,
} from './middlewares.js'

export {
  AUTH_SECURITY_SCHEMES,
  authPlugin,
  type AuthPluginOptions,
} from './plugin.js'

export type {
  AdditionalPublicKey,
  AuthCookieOptions,
  AuthOptions,
  AuthSession,
  AuthUser,
  BeforeLoginEvent,
  ClientOptions,
  DataProvider,
  IssuedTokens,
  KeyPairOptions,
  LoginErrorType,
  LoginFailedEvent,
  LoginSuccessEvent,
  LoginThrottleOptions,
  LogoutScope,
  NewRefreshToken,
  RateLimit,
  RefreshTokenData,
  RefreshTokenReuseEvent,
  RevokedSession,
  SessionOptions,
  TokenPair,
  TokenSubject,
  UserIdentifiers,
} from './types.js'
