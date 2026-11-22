# @dotpress/auth

## 2.0.0-alpha.8

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.8

## 2.0.0-alpha.7

### Minor Changes

- [#29](https://github.com/dotpressjs/dotpress/pull/29) [`6a2aa47`](https://github.com/dotpressjs/dotpress/commit/6a2aa47f5e94ca2916e3de6b2c08b906cfe023a4) Thanks [@renoguyon](https://github.com/renoguyon)! - **Breaking (prerelease):** the errors of the authentication routes carry their code in the `error` field, with a sentence in `message`, like every error of Dotpress. Before, the code was in `message`, and `error` held the generic code of the status.
  
  ```json
  { "status": 401, "error": "EXPIRED_REFRESH_TOKEN", "message": "The session has expired. Log in again." }
  ```
  
  Clients test `error` (or the status) instead of `message`. The codes are typed by the new `AuthRouteErrorCode` export: `INVALID_LOGIN`, `TOO_MANY_LOGIN_ATTEMPTS`, `NO_TOKENS_PROVIDED`, `INVALID_REFRESH_TOKEN`, `EXPIRED_REFRESH_TOKEN`, `COOKIES_NOT_ENABLED`, `ACCESS_TOKEN_NOT_IN_COOKIE`, `NO_REFRESH_TOKEN`, `NO_ACCESS_TOKEN` and `CROSS_ORIGIN_REQUEST`.

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.7

## 2.0.0-alpha.6

### Patch Changes

- Updated dependencies [[`eacaf1c`](https://github.com/dotpressjs/dotpress/commit/eacaf1ce2c9168b46c103d89773cade65ed5650e)]:
  - @dotpress/core@2.0.0-alpha.6

## 2.0.0-alpha.5

### Minor Changes

- [#20](https://github.com/dotpressjs/dotpress/pull/20) [`4c9eac4`](https://github.com/dotpressjs/dotpress/commit/4c9eac4479b3c8e3af18b3b5812920aad205ab78) Thanks [@renoguyon](https://github.com/renoguyon)! - API review of the auth package, before the beta. Breaking changes:
  
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

- [#17](https://github.com/dotpressjs/dotpress/pull/17) [`7c669aa`](https://github.com/dotpressjs/dotpress/commit/7c669aa7398a66d01176819417eb41cb38110a48) Thanks [@renoguyon](https://github.com/renoguyon)! - API review of the core, before the beta. Breaking changes:
  
  - `new HttpError(status, code, message, { data, cause })`: the data and the cause are options. The error helpers take the same options: `notFoundError('Task not found', { data: { id } })`, and `errorResponse(status, code, message, options)`. Unknown options throw a `TypeError`.
  - What adapters need moved to `@dotpress/core/adapter`: `CompiledRoute`, `DotpressRuntime`, `createRouteMatcher()`, `parseQueryString()`, `parseRequestBody()`, `DEFAULT_BODY_LIMIT`, `fromWebRequest()`, `readRequestBody()`, `toWebResponse()`, and the body errors (`malformedBodyError()`, `payloadTooLargeError()`, `unsupportedMediaTypeError()`). Helpers used only by the core tests are no longer exported: `fromWebHeaders()`, `parseCookieHeader()`, `serializeCookie()`, `HTTP_METHODS`, `isHttpMethod()`, `isResponseResult()`, `routeNotFoundError()`, `methodNotAllowedError()`.
  - `NormalizedResponse` has no `kind` anymore: adapters read the type of the `body`.
  - `Router` has no `getRoutes()` and `getResponseFilters()` anymore, and `RouteRecord` is no longer exported. `createApp()` only mounts routers made by `createRouter()`.
  - `createApp()`, the routes (with their `schema` and `meta`) and `createConsoleLogger()` reject unknown options, and the logger an unknown `level`.
  - `Duration` and `parseDuration()` are exported by `@dotpress/core`, no longer by `@dotpress/cache`.
  - `RateLimitStore`, `RateLimitState` and `createMemoryRateLimitStore()` are exported by `@dotpress/core`, to be shared by every rate limit: `@dotpress/auth` no longer exports them, nor `memoryRateLimitStore()`.
  
  `createApp()` warns when several copies of `@dotpress/core` are loaded: the routes declared with one copy are not mounted by the other.

### Patch Changes

- [#23](https://github.com/dotpressjs/dotpress/pull/23) [`7a5edeb`](https://github.com/dotpressjs/dotpress/commit/7a5edeba1d104850a528ffd05909e766332694a4) Thanks [@renoguyon](https://github.com/renoguyon)! - Last lot of the API review, before the beta. Breaking changes:
  
  - One verb per operation: `api.addRoute()` becomes `api.defineRoute()`, `api.addRouteGroup()` becomes `api.createGroup()`, and the global `registerResponseFilter()` becomes `addResponseFilter()`, like the methods of routers and plugins.
  - `RouteResponse` becomes `DocumentedResponse`, and `SchemaDefinition`, `SchemaInput` and `SchemaOutput` become `RouteSchemaDefinition`, `RouteSchemaInput` and `RouteSchemaOutput`.
  - `app.listen()` and `HttpAdapter.listen()` return the address of the server, `{ port, host }`: the actual port with `listen(0)`.
  - `redirect(location, { status, headers })` takes an options object, and checks the status.
  - The `origin` function of the `cors` option and `generateRequestId` receive the request of the app (`DotpressRequest`, with `header()`), not the normalized request of the adapter.
  - `RouteMeta.tags` and `security` accept readonly arrays (`as const`).
  - The options of the adapters have a default type parameter (`HonoAdapterOptions` is `HonoAdapterOptions<Hono>`), and the Fastify adapter refuses to listen twice.
  - `@dotpress/testing` exports the types of its signatures: `EnvelopeLike`, `SentMailAddress` and `ExpectedAddresses`.
  
  The error messages of the configuration follow one format, `fn(): message.`, or the subject they are about (`Route "/users": …`).
- Updated dependencies [[`7a5edeb`](https://github.com/dotpressjs/dotpress/commit/7a5edeba1d104850a528ffd05909e766332694a4), [`7c669aa`](https://github.com/dotpressjs/dotpress/commit/7c669aa7398a66d01176819417eb41cb38110a48)]:
  - @dotpress/core@2.0.0-alpha.5

## 2.0.0-alpha.4

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.4

## 2.0.0-alpha.3

### Patch Changes

- [#7](https://github.com/dotpressjs/dotpress/pull/7) [`9432ce3`](https://github.com/dotpressjs/dotpress/commit/9432ce318a55287ce2431837075162743dd2389b) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: each package describes itself with an example, and links to its pages on the documentation site, dotpress.dev, which holds the guides and the reference.
- Updated dependencies [[`9432ce3`](https://github.com/dotpressjs/dotpress/commit/9432ce318a55287ce2431837075162743dd2389b)]:
  - @dotpress/core@2.0.0-alpha.3

## 2.0.0-alpha.2

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.2

## 2.0.0-alpha.1

### Patch Changes

- [`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: Dotpress V2 is published as an alpha. Until 2.0.0, install `@dotpress/auth` with the `alpha` tag (`pnpm add @dotpress/auth@alpha`): without it, `@dotpress/auth` is the 1.x.
- Updated dependencies [[`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4)]:
  - @dotpress/core@2.0.0-alpha.1
