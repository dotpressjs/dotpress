# Auth

The settings, routes, errors and contracts of `@dotpress/auth`. For a guide, see [Authentication](/auth/).

## createAuth()

```ts
import { createAuth } from '@dotpress/auth'

const auth = createAuth({ keys, issuer: 'https://api.example.com', dataProvider })
```

| Setting | Default | Description |
| --- | --- | --- |
| `keys` | required | `privateKey` (PKCS#8 PEM) and `publicKey` (SPKI PEM), plus optional `kid` and `additionalPublicKeys`. RS256. See [Keys and rotation](/auth/keys). |
| `issuer` | required | The `iss` claim, checked on every request: the URL of the API, one value per environment and application. |
| `dataProvider` | required | The storage of users and refresh tokens: see [DataProvider](#dataprovider). |
| `audience` | `issuer` | The `aud` claim: the API that accepts the tokens. Checked on every request. |
| `accessTokenTTL` | `'15m'` | Lifetime of the access tokens. |
| `session.idleTimeout` | `'14d'` | The session ends when it is not refreshed during this delay. |
| `session.absoluteTimeout` | none | The session ends this delay after login, even when active. |
| `clients` | — | `{ allowed, required?, isUserRoleAllowed?({ userId, role, clientId }), sessions? }`: see [Clients](/auth/clients). |
| `cookies` | disabled | The cookie mode: see [Cookie settings](#cookie-settings). |
| `loginThrottle` | enabled, in memory | `{ store?, limits? }`, or `false`. See [Brute force protection](/auth/passwords#brute-force-protection). |
| `beforeLogin` | — | `({ username, clientId, ipAddress, req }) => …`, after the throttle and before the password check. Return an `HttpError` to reject the attempt. |
| `onLoginSuccess` | — | Called with `{ userId, username, clientId, ipAddress }`. |
| `onLoginFailed` | — | Called with `{ username, errorType, clientId, ipAddress }`. `errorType`: `invalid_username`, `invalid_password`, `invalid_role` or `too_many_attempts`. |
| `passwordHashRounds` | `12` | bcrypt cost of `hashPassword()`, and of the dummy hash compared for unknown users. |
| `usernameClaim` | `false` | Writes the `username` claim in the access tokens. |
| `getUserRoles` | `user.roles`, or `user.role` | The roles checked by `requireRole()`. |
| `refreshTokenReuseInterval` | `'10s'` | Delay after its first use during which a refresh token presented again gets a new pair in the same session. `0` disables it. |
| `onRefreshTokenReuse` | — | Called with `{ userId, sessionId, accessTokenId }` when a session is revoked because a used refresh token came back. |

The durations are [`Duration` values](/concepts/options#durations), rounded to the second: a number of seconds, or a string like `'15m'` or `'14d'`. Invalid or unknown settings make `createAuth()` throw; a missing `issuer`, a `publicKey` that does not match the `privateKey`, or a PKCS#1 key make the app fail at startup, with an explicit message.

### Cookie settings

| Setting | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Enables the cookie mode: login with `mode: 'cookie'`. |
| `accessTokenInCookie` | `false` | Also sets the access token as a cookie. Recommended for browsers. |
| `httpOnly` | `true` | Hides the cookies from the JavaScript of the page. |
| `secure` | `true` | HTTPS only. Browsers accept secure cookies on `http://localhost`. |
| `sameSite` | `'lax'` | `SameSite` of the access token cookie. |
| `refreshTokenSameSite` | `'strict'` | `SameSite` of the refresh token cookie; `'none'` when `sameSite` is `'none'`. |
| `trustedOrigins` | the `cors` origins with credentials, else `[]` | Other origins allowed to send authenticated cookie requests. |
| `domain` | — | Domain of the cookies. Without it, the host only. |
| `path` | `'/'` | Path of the access token cookie. |
| `refreshTokenPath` | the path of the auth routes | Path of the refresh token cookie. |
| `accessTokenName` | `__Host-dotpress_access_token` | Name of the access token cookie. |
| `refreshTokenName` | `__Secure-dotpress_refresh_token` | Name of the refresh token cookie. |

See [Cookie mode and CSRF](/auth/cookies).

## authPlugin()

```ts
authPlugin(auth, { prefix: '/auth', routes: true, jwks: false })
```

| Option | Default | Description |
| --- | --- | --- |
| `prefix` | `'/auth'` | Prefix of the routes. |
| `routes` | `true` | `false` keeps only the authentication of the requests. |
| `jwks` | `false` | Publishes the public keys at `GET /.well-known/jwks.json`, cached 5 minutes. |

The plugin is named `auth`, provides `ctx.user` and `ctx.auth`, and declares the `bearerAuth` security scheme (`AUTH_SECURITY_SCHEMES`) for OpenAPI.

### Routes

| Route | Body | Response |
| --- | --- | --- |
| `POST /auth/login` | `{ username, password, clientId?, mode? }` | The tokens (see below), `userId`, `expiresIn`, `expiresAt`, `sessionExpiresAt?` |
| `POST /auth/refresh` | `{ accessToken, refreshToken }`, or cookies | A new pair, same fields |
| `GET /auth/me` | — | The user (`AuthUser`) |
| `POST /auth/restore` | — (cookies) | `userId`, `user`, `expiresIn`, `expiresAt`, `sessionExpiresAt?`. Requires `cookies.accessTokenInCookie`. |
| `POST /auth/logout` | `{ refreshToken?, scope? }` | `200`, and the cookies cleared |

| Configuration | Cookies | Tokens in the body |
| --- | --- | --- |
| Body mode | — | `accessToken`, `refreshToken` |
| `cookies: { enabled: true }`, `mode: 'cookie'` | refresh token | `accessToken` |
| `cookies: { enabled: true, accessTokenInCookie: true }`, `mode: 'cookie'` | both | none |

`expiresAt` is the expiration of the access token; `sessionExpiresAt` is set when an absolute timeout applies.

### Errors

The routes answer the standard error format; the `message` carries the reason:

| Status | `message` | When |
| --- | --- | --- |
| `400` | `Validation failed` | Invalid body, or a `clientId` outside `clients.allowed` |
| `401` | `INVALID_LOGIN` | Unknown username, wrong password, account without password, or a role not allowed for the client |
| `429` | `TOO_MANY_LOGIN_ATTEMPTS` | Over a limit of the login throttle, with `Retry-After` |
| `401` | `NO_TOKENS_PROVIDED` | `/auth/refresh` without tokens, in the body or as cookies |
| `401` | `INVALID_REFRESH_TOKEN` | Unknown, revoked or reused refresh token, an access token that does not match, or a user `findUserById()` no longer returns |
| `401` | `EXPIRED_REFRESH_TOKEN` | The session reached its inactivity or absolute timeout |
| `401` | `COOKIES_NOT_ENABLED`, `ACCESS_TOKEN_NOT_IN_COOKIE` | `/auth/restore` without the cookie mode, or without `accessTokenInCookie` |
| `401` | `NO_REFRESH_TOKEN`, `NO_ACCESS_TOKEN` | `/auth/restore` without one of the cookies |
| `403` | `CROSS_ORIGIN_REQUEST` | A cookie request from an untrusted origin, on `/auth/refresh`, `/auth/restore` or `/auth/logout` |
| `401` | `Unauthorized` | `/auth/logout` with `scope: 'all'`, without a valid access token or an active refresh token |

Outside the routes, the service throws an `AuthError` whose `code` is `INVALID_ACCESS_TOKEN`, `INVALID_REFRESH_TOKEN`, `EXPIRED_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED` or `SESSION_REVOKED`.

## Guards

| Middleware | Answers | Guarantees |
| --- | --- | --- |
| `requireAuth` | `401` without user | `ctx.user: AuthUser`, `ctx.auth: AuthSession` |
| `requireRole(...roles)` | `401` without user, `403` without one of the roles | the same |
| `requireClient(...clientIds)` | `401` without user, `403` for a token of another client | the same |

A `401` gets a `WWW-Authenticate: Bearer` header (RFC 6750), with `error="invalid_token"` when the request carried an expired, revoked or invalid token. See [Protecting routes](/auth/protecting-routes).

## The service

| Method | Description |
| --- | --- |
| `generateTokensForUser({ userId, username?, clientId? })` | Generates and stores a token pair, starting a session. |
| `refreshTokens({ accessToken, refreshToken })` | Rotates a pair. Returns the new pair, `userId` and `user`. |
| `verifyAccessToken(accessToken)` | Verifies a valid access token, and returns its `AuthSession`. |
| `revokeSession(refreshToken, { scope? })` | Revokes the session of a refresh token, or every session of the user with `scope: 'all'`. Returns `{ userId, sessionId }`, or `undefined` when nothing was revoked. |
| `revokeUserSessions(userId)` | Revokes every session of a user, on every device: after a password change, or when an account is disabled. |
| `hashPassword(password)` | bcrypt hash, with `passwordHashRounds`. Throws a `RangeError` beyond 72 bytes. |
| `verifyPassword(password, hash)` | Compares with bcrypt; a missing hash (unknown user, account without password) is compared with a dummy one, in the same time, and gives `false`. |
| `passwordNeedsRehash(hash)`, `rehashPassword(password)` | Upgrade the cost of a hash. |
| `setAuthCookies(res, tokens)`, `clearAuthCookies(res)` | Set or clear the cookies, in a route. |
| `isCookieAuthenticationAllowed(req)` | `Promise<boolean>`: the protection against cross-site requests of the plugin. |
| `getSessionExpiresAt(session)` | End of a session with an absolute timeout. |
| `getJwks()` | The public keys, as a JSON Web Key Set. |
| `getUserRoles(user)` | The roles of a user. |

`generatePasswordHash(password, { rounds? })` and `isPasswordTooLong(password)` are also exported, without a service.

## AuthSession

`ctx.auth`, the data of the access token:

| Field | Claim | Description |
| --- | --- | --- |
| `userId` | `sub` | The user. |
| `accessTokenId` | `jti` | The access token. |
| `sessionId` | `sid` | The session: the `sessionId` of its refresh tokens. |
| `clientId` | `client_id` | The client, with the `clients` setting. |
| `username` | `username` | With `usernameClaim: true` only. |
| `roles` | — | The roles of the user. |
| `claims` | — | Every claim of the token. |

Access tokens follow RFC 9068: `typ: at+jwt`, RS256, and the `iss`, `aud`, `sub`, `jti`, `iat`, `exp` and `auth_time` claims. `auth_time` is the start of the session.

## DataProvider

```ts
interface DataProvider {
  storeRefreshToken(payload: {
    token: string
    tokenHash: string // SHA-256 of the token: store this one only
    userId: string
    accessTokenId: string // the access token issued with it
    sessionId: string // the session
    expiresAt: Date
  }): Promise<void>
  findRefreshToken(tokenHash: string): Promise<
    | {
        userId: string
        accessTokenId: string
        sessionId?: string | null
        expiresAt: Date
        isUsed: boolean
        usedAt?: Date | null
        revokedAt?: Date | null
      }
    | undefined
  >
  markRefreshTokenAsUsed(tokenHash: string, usedAt: Date): Promise<void>
  revokeUserTokens(userId: string): Promise<void> // every session of a user
  revokeSessionTokens(sessionId: string): Promise<void> // one session
  findUserById(userId: string): Promise<AuthUser | undefined> // undefined for deleted or disabled accounts
  findUserIdentifiers(username: string): Promise<
    { userId: string; passwordHash: string | null; role?: string } | undefined
  >
  isSessionRevoked?(sessionId: string): Promise<boolean> // optional: immediate revocation
  updatePasswordHash?(userId: string, passwordHash: string): Promise<void> // optional: hash upgrade
}
```

`isUsed` can be derived from `usedAt`. Refresh tokens are 128 random bytes; only their hash is stored. See [Data provider](/auth/data-provider).
