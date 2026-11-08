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

export type {
  AuthSession,
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
  RefreshTokenData,
  RefreshTokenReuseEvent,
  ResolvedAuthSettings,
  ResolvedCookieSettings,
  ResolvedSessionSettings,
  SessionSettings,
  StoreRefreshTokenDto,
  TokenPair,
  TokenSubject,
  UserIdentifiers,
} from './types.js'
