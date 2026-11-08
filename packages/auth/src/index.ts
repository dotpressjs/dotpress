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
  AudienceSettings,
  AuthSession,
  AuthSettings,
  AuthUser,
  CookieSettings,
  CreatedAccessToken,
  CreatedRefreshToken,
  DataProvider,
  KeyPairSettings,
  LoginFailedEvent,
  LoginSuccessEvent,
  RefreshTokenData,
  ResolvedAuthSettings,
  ResolvedCookieSettings,
  StoreRefreshTokenDto,
  TokenPair,
  TokenSubject,
  UserIdentifiers,
} from './types.js'
