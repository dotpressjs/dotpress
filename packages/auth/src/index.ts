import './context.js'

export {
  AuthError,
  createAuth,
  generatePasswordHash,
  type Auth,
  type AuthErrorCode,
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
  extractAccessToken,
  type AuthPluginOptions,
} from './plugin.js'

export {
  memoryRateLimitStore,
  type MemoryRateLimitStoreOptions,
  type RateLimitState,
  type RateLimitStore,
} from './rate-limit.js'

export type {
  AdditionalPublicKey,
  AuthSession,
  BeforeLoginEvent,
  AuthSettings,
  AuthUser,
  ClientSettings,
  CookieSettings,
  CreatedAccessToken,
  CreatedRefreshToken,
  DataProvider,
  IssuedTokens,
  KeyPairSettings,
  LoginFailedEvent,
  LoginSuccessEvent,
  LoginThrottleSettings,
  RateLimit,
  RefreshTokenData,
  RefreshTokenReuseEvent,
  ResolvedAuthSettings,
  ResolvedCookieSettings,
  ResolvedLoginThrottleSettings,
  ResolvedSessionSettings,
  SessionSettings,
  StoreRefreshTokenDto,
  TokenPair,
  TokenSubject,
  UserIdentifiers,
} from './types.js'
