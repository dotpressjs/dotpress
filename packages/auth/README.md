# @dotpress/auth

JWT authentication plugin for [Dotpress](https://dotpress.dev): login, token rotation, cookie sessions, and typed `ctx.user`. Works with any ORM through a small data provider, and on any adapter.

> 🚧 Dotpress V2 is under active development and not published yet.

```sh
pnpm add @dotpress/auth @dotpress/core zod
```

## Quick start

```ts
import { createApp, defineRoute } from '@dotpress/core'
import { expressAdapter } from '@dotpress/adapter-express'
import { authPlugin, createAuth, requireAuth } from '@dotpress/auth'

declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
    email: string
    roles: string[]
  }
}

const auth = createAuth({
  keys: {
    secretKey: process.env.JWT_PRIVATE_KEY!, // PKCS#8 PEM ("BEGIN PRIVATE KEY")
    publicKey: process.env.JWT_PUBLIC_KEY!, // SPKI PEM ("BEGIN PUBLIC KEY")
  },
  issuer: 'https://api.example.com', // required, checked on every request
  dataProvider, // see below
})

defineRoute({
  path: '/profile',
  middlewares: [requireAuth],
  handler: ({ user }) => user, // AuthUser
})

const app = await createApp({ adapter: expressAdapter(), plugins: [authPlugin(auth)] })
await app.listen(3000)
```

The plugin reads the access token of every request (`Authorization: Bearer` header, then the access token cookie when enabled, then an `accessToken` body field). When it is valid, `ctx.user` and `ctx.auth` are set; otherwise the request stays anonymous.

## Routes

| Route | Description |
| --- | --- |
| `POST /auth/login` | `{ username, password, clientId?, mode? }` → token pair. `mode: 'cookie'` sets the cookies instead (see below). |
| `POST /auth/refresh` | Rotates a token pair, sent in the body or as cookies. |
| `GET /auth/me` | Authenticated user. |
| `POST /auth/restore` | Restores a cookie session (requires `cookies.accessTokenInCookie`). |
| `POST /auth/logout` | Revokes the refresh tokens of the user and clears the cookies. |

In cookie mode, tokens set as cookies are never returned in the response body, so that the JavaScript of the page cannot read them:

| Configuration | Cookies | Body |
| --- | --- | --- |
| Body mode | — | `accessToken`, `refreshToken` |
| `cookies: { enabled: true }` | refresh token | `accessToken` (send it in the `Authorization` header) |
| `cookies: { enabled: true, accessTokenInCookie: true }` | refresh token, access token | no token |

Every route still returns `userId`, `expiresIn` and `expiresAt` (access token expiration), plus `sessionExpiresAt` when the session has an absolute timeout (see [Sessions](#sessions)).

### Cross-site request forgery

The browser attaches cookies to every request, including the ones forged by another site. In cookie mode, the plugin checks the origin of the requests authenticated by a cookie, with the headers set by the browser (`Sec-Fetch-Site`, then `Origin` for older browsers), like the OWASP recommendations and Go's `http.CrossOriginProtection`. Clients need no CSRF token.

- Requests from the API origin are accepted, as well as requests without these headers (non-browser clients).
- Requests from another origin, including another subdomain of the same site, are accepted only from `cookies.trustedOrigins`:

  ```ts
  cookies: { enabled: true, accessTokenInCookie: true, trustedOrigins: ['https://app.example.com'] }
  ```

- Otherwise, the access token cookie is ignored (the request is anonymous, and a warning is logged), and `/auth/refresh` and `/auth/restore` answer `403 CROSS_ORIGIN_REQUEST`.
- `GET`, `HEAD` and `OPTIONS` requests are not checked: they must not change data.
- Requests authenticated by the `Authorization` header are not checked: another site cannot set it.

For older browsers without `Sec-Fetch-Site`, the `Origin` is compared with the `Host` header: behind a proxy, forward the original `Host`, or list the origin in `trustedOrigins`.

The refresh token cookie is `SameSite=Strict`: it never accompanies a navigation from another site, while the requests of the app keep sending it.

`authPlugin(auth, { prefix: '/api/auth' })` changes the prefix; `{ routes: false }` keeps only the authentication middleware.

## Guards

```ts
import { requireAuth, requireRole } from '@dotpress/auth'

defineRoute({ path: '/me', middlewares: [requireAuth], handler: ({ user }) => user })

createRouteGroup('/admin', [requireRole('admin')]).defineRoute({
  path: '/stats',
  handler: ({ user, auth }) => ({ admin: user.id, roles: auth.roles }),
})
```

`requireAuth` answers `401`; `requireRole()` answers `401` without user and `403` without one of the roles; `requireClient()` answers `401` without user and `403` when the token was issued for another client (see [Clients](#clients)). In the handlers of guarded routes, `ctx.user` and `ctx.auth` are typed as defined. Roles come from the user `roles` array (or `role` string), or from the `getUserRoles` setting.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `keys` | — | RSA key pair: `secretKey` (PKCS#8 PEM) and `publicKey` (SPKI PEM). Tokens are signed with RS256. |
| `dataProvider` | — | Storage of users and refresh tokens. |
| `accessTokenTTL` | `3600` | Access token lifetime, in seconds. |
| `session` | `{ idleTimeout: 14 days }` | Session lifetimes, in seconds: `idleTimeout` (inactivity) and `absoluteTimeout` (none by default). See [Sessions](#sessions). |
| `issuer` | — | **Required.** `iss` claim, checked on every request: for example the URL of the API. Use one value per environment and application, especially when they share a key pair. |
| `audience` | `issuer` | `aud` claim (the API that accepts the tokens), checked on every request. |
| `clients` | — | `{ allowed, required?, isUserRoleAllowed?(role, clientId), sessions? }`: client applications (see [Clients](#clients)). |
| `cookies` | disabled | Cookie mode: `enabled`, `httpOnly` (`true`), `secure` (`true`), `sameSite` (`lax`), `refreshTokenSameSite` (`strict`, or `none` when `sameSite` is `none`), `trustedOrigins` (`[]`, see [Cross-site request forgery](#cross-site-request-forgery)), `domain`, `path` (`/`), `accessTokenName`, `refreshTokenName`, `accessTokenInCookie` (`false`). |
| `onLoginSuccess` / `onLoginFailed` | — | Login events (user, `clientId`, IP address). |
| `passwordHashRounds` | `10` | bcrypt cost of `hashPassword()` and of the dummy hash used for unknown users. Set it to the cost of the hashes stored in your database. |
| `getUserRoles` | `user.roles` / `user.role` | Roles checked by `requireRole()`. |
| `refreshTokenReuseInterval` | `10` | Seconds after its first use during which a refresh token may be presented again and get a new token pair in the same session (concurrent refreshes, retries). `0` disables it. |
| `onRefreshTokenReuse` | — | Called with `{ userId, familyId, jwtId }` when a session is revoked because a used refresh token was reused. |

To convert PKCS#1 keys (`BEGIN RSA PRIVATE KEY`):

```sh
openssl pkcs8 -topk8 -nocrypt -in private.pem -out private.pkcs8.pem
openssl rsa -RSAPublicKey_in -in public.pem -pubout -out public.spki.pem # BEGIN RSA PUBLIC KEY only
```

## Access tokens

Access tokens follow [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068): `typ: at+jwt` header, RS256 signature, and the `iss`, `aud`, `sub`, `jti`, `iat`, `exp`, `auth_time` and `username` claims, plus `client_id` when the token was issued for a client. The type, issuer, audience and client are checked on every request.

## Clients

When one API serves several applications (an app and a backoffice, for example), declare them:

```ts
const auth = createAuth({
  // …
  clients: {
    allowed: ['app', 'backoffice'],
    required: true, // clientId required at login
    isUserRoleAllowed: (role, clientId) => clientId !== 'backoffice' || role === 'admin',
  },
})

createRouteGroup('/backoffice', [requireClient('backoffice'), requireRole('admin')])
```

The login `clientId` must be one of `allowed` (`400` otherwise), and `isUserRoleAllowed` checks that the user may get a token for it. The token carries a `client_id` claim, exposed as `ctx.auth.clientId`.

> The client identifier is declared by the caller: anyone can send `clientId: 'backoffice'`. A `client_id` claim does not prove which application sends a request; it means that the token was issued under the policy of that client (`isUserRoleAllowed`). `requireClient()` keeps the tokens of one application away from the routes of another; combine it with `requireRole()`.

Without `clients` setting, the login `clientId` is only reported in the login events, and not written in the token.

## Data provider

```ts
import type { DataProvider } from '@dotpress/auth'

const dataProvider: DataProvider = {
  storeRefreshToken: ({ tokenHash, userId, jwtId, familyId, expiresAt }) => db.refreshToken.create({ … }),
  findRefreshToken: (tokenHash) => db.refreshToken.find({ tokenHash }), // { userId, jwtId, familyId, expiresAt, isUsed, usedAt, revokedAt }
  markRefreshTokenAsUsed: (tokenHash, usedAt) => db.refreshToken.update({ tokenHash }, { isUsed: true, usedAt }),
  revokeTokens: (userId) => db.refreshToken.updateMany({ userId }, { revokedAt: new Date() }),
  revokeTokenFamily: (familyId) => db.refreshToken.updateMany({ familyId }, { revokedAt: new Date() }),
  findUserById: (userId) => db.user.findPublicProfile(userId),
  findUserIdentifiers: (username) => db.user.findCredentials(username), // { userId, passwordHash (null without password), role? }
}
```

Refresh tokens are random 128-byte values; only their SHA-256 hash is stored.

## Account enumeration

A login fails with the same `401 INVALID_LOGIN` response, in the same time, whether the username is unknown, the account has no password (`passwordHash: null`, for SSO accounts), or the password is wrong: unknown users are checked against a dummy bcrypt hash, computed at startup with `passwordHashRounds`. Two things keep it effective:

- `passwordHashRounds` must match the cost of the hashes stored in your database;
- `onLoginFailed` must do the same work whatever the `errorType` (for example, do not update the user row only on `invalid_password`).

## Sessions

A session starts at login and is extended by each refresh. It ends after one of two timeouts, in seconds:

| Setting | Default | The session ends… |
| --- | --- | --- |
| `session.idleTimeout` | 14 days | when it is not refreshed during this delay (lifetime of each refresh token) |
| `session.absoluteTimeout` | none | this delay after login, even when it is active |

Without absolute timeout, an active session never ends, like on most consumer apps. Examples:

```ts
const DAY = 24 * 60 * 60

session: { idleTimeout: 30 * DAY } // consumer app: never logged out while active
session: { idleTimeout: DAY, absoluteTimeout: DAY } // backoffice: log in every day
session: { idleTimeout: 7 * DAY, absoluteTimeout: 28 * DAY } // log in every 4 weeks
```

With an absolute timeout, the access tokens, refresh tokens and cookies never outlive the session, and responses return `sessionExpiresAt`, so that the client can warn the user. The session start is the `auth_time` claim of the access token. Adding an absolute timeout also ends the sessions opened before.

Each client can have its own lifetimes (an explicit `absoluteTimeout: undefined` removes the global one):

```ts
clients: {
  allowed: ['app', 'backoffice'],
  sessions: { backoffice: { idleTimeout: DAY, absoluteTimeout: DAY } },
}
```

An ended session makes `/auth/refresh` answer `401 EXPIRED_REFRESH_TOKEN`: the user must log in again.

## Refresh token rotation

Each refresh returns a new refresh token and invalidates the previous one. All the refresh tokens of a session share a `familyId`, created at login.

A refresh token can only be used once. When a used token is presented again, it was probably stolen (the attacker and the legitimate client both hold it): the whole session is revoked, `onRefreshTokenReuse` is called, and the request gets `401 INVALID_REFRESH_TOKEN`. Within `refreshTokenReuseInterval` (10 seconds by default) after its first use, a token presented again gets a new token pair in the same session, like with Auth0 or Okta: concurrent refreshes (several tabs) and retries after a lost response keep working. The interval is counted from the first use and is not extended by later presentations. Reusing the token after the interval revokes the whole session, including the pairs issued within the interval.

## Service

`createAuth()` also works without an app (scripts, workers):

```ts
const { accessToken, refreshToken } = await auth.generateTokensForUser({ userId, username })
const session = await auth.verifyAccessToken(accessToken)
const hash = await auth.hashPassword('secret') // or generatePasswordHash()
auth.setAuthCookies(ctx.res, { accessToken, refreshToken })
```

## License

MIT
