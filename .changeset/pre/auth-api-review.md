---
'@dotpress/auth': minor
---

API review of the auth package, before the beta. Breaking changes:

- `auth.settings` is no longer public (it exposed the private key), nor `auth.init()`, `AuthInitOptions`, the `Resolved*` types and `extractAccessToken()`. `authPlugin()` only accepts a service created with `createAuth()`.
- The data provider no longer receives the refresh token in clear: `storeRefreshToken()` gets its `tokenHash` only. `StoreRefreshTokenDto` is renamed `NewRefreshToken`.
- One name per concept in the contract of the data provider: `sessionId` instead of `familyId`, and `accessTokenId` instead of `jwtId` (and of `AuthSession.tokenId`). `revokeTokenFamily(familyId)` is renamed `revokeSessionTokens(sessionId)`, and `revokeTokens(userId)` `revokeUserTokens(userId)`.
- New `auth.revokeUserSessions(userId)`: revokes every session of a user, after a password change for instance.
- `keys.secretKey` is renamed `keys.privateKey`.
- The setting types are named `*Options`: `AuthOptions`, `AuthCookieOptions`, `ClientOptions`, `SessionOptions`, `LoginThrottleOptions`, `KeyPairOptions`.
- `createAuth()` (nested settings included) and `authPlugin()` reject unknown options.
- The durations accept a `Duration`, rounded to the second: `accessTokenTTL: '15m'`, `session: { idleTimeout: '14d' }`, `refreshTokenReuseInterval`, and the `window` of the login limits.
- `generateAccessToken()` and `generateRefreshToken()` are removed: every access token belongs to a session, and access tokens without session are rejected. `AuthSession.sessionId` is always a string.
- `hashPassword(password)` no longer takes a cost, `generatePasswordHash(password, { rounds })` takes it as an option, and `MAX_PASSWORD_BYTES` is no longer exported. `setAuthCookies()` no longer takes a third parameter.
- `clients.isUserRoleAllowed({ userId, role, clientId })` takes an object.
- The hooks (`onLoginFailed`, `onLoginSuccess`, `onRefreshTokenReuse`) may be synchronous. `LoginErrorType` names the `errorType` of `LoginFailedEvent`.
