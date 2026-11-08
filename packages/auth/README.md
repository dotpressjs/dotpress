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

The plugin reads the access token of every request: the `Authorization: Bearer` header, then the access token cookie when enabled. When it is valid, `ctx.user` and `ctx.auth` are set; otherwise the request stays anonymous.

The request body is never read, so an app route can receive an `accessToken` field of its own (a third-party token, for example) without side effects. Only `POST /auth/refresh` reads tokens from the body (see the table below).

## Routes

| Route | Description |
| --- | --- |
| `POST /auth/login` | `{ username, password, clientId?, mode? }` → token pair. `mode: 'cookie'` sets the cookies instead (see below). |
| `POST /auth/refresh` | Rotates a token pair, sent in the body or as cookies. |
| `GET /auth/me` | Authenticated user. |
| `POST /auth/restore` | Restores a cookie session (requires `cookies.accessTokenInCookie`). |
| `POST /auth/logout` | `{ refreshToken?, scope? }` → revokes the current session (`scope: 'all'`: every session of the user) and clears the cookies. See [Logout](#logout). |

In cookie mode, tokens set as cookies are never returned in the response body, so that the JavaScript of the page cannot read them:

| Configuration | Cookies | Body |
| --- | --- | --- |
| Body mode | — | `accessToken`, `refreshToken` |
| `cookies: { enabled: true }` | refresh token | `accessToken` (send it in the `Authorization` header) |
| `cookies: { enabled: true, accessTokenInCookie: true }` | refresh token, access token | no token |

Every route still returns `userId`, `expiresIn` and `expiresAt` (access token expiration), plus `sessionExpiresAt` when the session has an absolute timeout (see [Sessions](#sessions)).

### Cookie names and paths

| Cookie | Default name | Path | Lifetime |
| --- | --- | --- | --- |
| Access token | `__Host-dotpress_access_token` | `cookies.path` (`/`) | refresh token lifetime |
| Refresh token | `__Secure-dotpress_refresh_token` | `cookies.refreshTokenPath` (`/auth`) | refresh token lifetime |

The refresh token cookie is only sent to the auth routes. **`refreshTokenPath` is the browser path of the auth routes**: set it when the plugin has another prefix (`authPlugin()` fails at startup otherwise), or when a proxy serves the API under a path:

```ts
cookies: { enabled: true, refreshTokenPath: '/api/auth' } // browser URL: https://example.com/api/auth/refresh
```

With a wrong path, the browser does not send the cookie, and refreshes fail with `401 NO_TOKENS_PROVIDED`.

The default names get the strongest prefix their attributes allow, like Auth.js: `__Host-` (secure, without `domain`, path `/`) prevents a subdomain or an insecure page from overwriting the cookie; `__Secure-` (secure) prevents an insecure page from overwriting it. Without `secure`, the names have no prefix. Custom names are kept as is, and checked at startup: a `__Host-` or `__Secure-` name without the required attributes would be silently rejected by browsers.

The access token cookie lives as long as the refresh token, and not `accessTokenTTL`: refreshing requires the access token, even expired.

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

`authPlugin(auth, { prefix: '/api/auth' })` changes the prefix; `{ routes: false }` keeps only the authentication middleware; `{ jwks: true }` publishes the public keys (see [Keys and rotation](#keys-and-rotation)).

## Guards

```ts
import { requireAuth, requireRole } from '@dotpress/auth'

defineRoute({ path: '/me', middlewares: [requireAuth], handler: ({ user }) => user })

createRouteGroup('/admin', [requireRole('admin')]).defineRoute({
  path: '/stats',
  handler: ({ user, auth }) => ({ admin: user.id, roles: auth.roles }),
})
```

`requireAuth` answers `401` with a `WWW-Authenticate: Bearer` header (RFC 6750), plus `error="invalid_token"` when the `Authorization` header carried an expired, revoked or invalid token; every `401` of the app gets this header, unless it already has one. `requireRole()` answers `401` without user and `403` without one of the roles; `requireClient()` answers `401` without user and `403` when the token was issued for another client (see [Clients](#clients)). In the handlers of guarded routes, `ctx.user` and `ctx.auth` are typed as defined. Roles come from the user `roles` array (or `role` string), or from the `getUserRoles` setting.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `keys` | — | RSA key pair: `secretKey` (PKCS#8 PEM) and `publicKey` (SPKI PEM), plus optional `kid` and `additionalPublicKeys`. Tokens are signed with RS256. See [Keys and rotation](#keys-and-rotation). |
| `dataProvider` | — | Storage of users and refresh tokens. |
| `accessTokenTTL` | `900` | Access token lifetime, in seconds (15 minutes). See [Revocation](#revocation). |
| `session` | `{ idleTimeout: 14 days }` | Session lifetimes, in seconds: `idleTimeout` (inactivity) and `absoluteTimeout` (none by default). See [Sessions](#sessions). |
| `issuer` | — | **Required.** `iss` claim, checked on every request: for example the URL of the API. Use one value per environment and application, especially when they share a key pair. |
| `audience` | `issuer` | `aud` claim (the API that accepts the tokens), checked on every request. |
| `clients` | — | `{ allowed, required?, isUserRoleAllowed?(role, clientId), sessions? }`: client applications (see [Clients](#clients)). |
| `cookies` | disabled | Cookie mode: `enabled`, `httpOnly` (`true`), `secure` (`true`), `sameSite` (`lax`), `refreshTokenSameSite` (`strict`, or `none` when `sameSite` is `none`), `trustedOrigins` (`[]`, see [Cross-site request forgery](#cross-site-request-forgery)), `domain`, `path` (`/`, access token cookie), `refreshTokenPath` (`/auth`), `accessTokenName`, `refreshTokenName` (see [Cookie names and paths](#cookie-names-and-paths)), `accessTokenInCookie` (`false`). |
| `onLoginSuccess` / `onLoginFailed` | — | Login events (user, `clientId`, IP address). |
| `loginThrottle` | enabled, in memory | Brute force protection: `{ store?, limits? }`, or `false`. See [Brute force protection](#brute-force-protection). |
| `beforeLogin` | — | Called before checking the password: return an error to reject the attempt. |
| `passwordHashRounds` | `12` | bcrypt cost of `hashPassword()` and of the dummy hash used for unknown users. See [Passwords](#passwords). |
| `usernameClaim` | `false` | Writes the `username` claim in the access tokens (personal data, often an email address). |
| `getUserRoles` | `user.roles` / `user.role` | Roles checked by `requireRole()`. |
| `refreshTokenReuseInterval` | `10` | Seconds after its first use during which a refresh token may be presented again and get a new token pair in the same session (concurrent refreshes, retries). `0` disables it. |
| `onRefreshTokenReuse` | — | Called with `{ userId, familyId, jwtId }` when a session is revoked because a used refresh token was reused. |

## Keys and rotation

To generate a key pair:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem # PKCS#8
openssl pkey -in private.pem -pubout -out public.pem # SPKI
```

To convert PKCS#1 keys (`BEGIN RSA PRIVATE KEY`):

```sh
openssl pkcs8 -topk8 -nocrypt -in private.pem -out private.pkcs8.pem
openssl rsa -RSAPublicKey_in -in public.pem -pubout -out public.spki.pem # BEGIN RSA PUBLIC KEY only
```

`createApp()` fails when `publicKey` does not match `secretKey`.

Tokens carry a `kid` header: the RFC 7638 thumbprint of the public key, or `keys.kid`. It designates the verification key, among the configured keys only; tokens without `kid` (issued by V1) are tried with every key.

To rotate keys without logging users out, accept other public keys with `additionalPublicKeys`:

| Step | Configuration |
| --- | --- |
| 1. Announce the new key (rolling deployments) | old pair active, new public key in `additionalPublicKeys` |
| 2. Switch | new pair active, old public key in `additionalPublicKeys` |
| 3. After `session.idleTimeout` | remove the old public key |

```ts
keys: {
  secretKey: process.env.JWT_PRIVATE_KEY!, // new pair
  publicKey: process.env.JWT_PUBLIC_KEY!,
  additionalPublicKeys: [process.env.JWT_PREVIOUS_PUBLIC_KEY!],
}
```

Keep the old public key for the inactivity timeout of the sessions (14 days by default), not only for the access token lifetime: a refresh verifies the signature of the (expired) access token, so an inactive client still presents a token of the old key. After a compromise, configure the new pair alone at once: the tokens of the old key, including forged ones, are rejected, and every user logs in again.

`authPlugin(auth, { jwks: true })` publishes the public keys at `GET /.well-known/jwks.json` (cached 5 minutes), so that other services can verify the tokens and follow rotations, for example with `createRemoteJWKSet()` of jose. `auth.getJwks()` returns the same key set.

## Brute force protection

Login attempts are counted per username, whether the account exists or not (a `429` does not reveal it), before the password is checked:

| Counter | Default | Against |
| --- | --- | --- |
| username + IP address | 5 per minute | brute force from one client, without letting others block the account |
| username | 100 per hour (NIST 800-63B) | distributed brute force on an account |

Over a limit, the login answers `429 TOO_MANY_LOGIN_ATTEMPTS` with a `Retry-After` header, and `onLoginFailed` gets `errorType: 'too_many_attempts'`. A successful login clears the counter of the client. Usernames are normalized (letter case, spaces), and the counter keys are hashed.

```ts
createAuth({
  loginThrottle: {
    store: redisStore, // see below
    limits: { usernameAndIp: { max: 10, window: 60 }, username: false },
  },
})
```

`loginThrottle: false` disables it, when the infrastructure (gateway, WAF) already limits `/auth/login`. The client IP address comes from the HTTP server: behind a proxy, configure it to trust the proxy headers (Express `trust proxy`), or every client shares the proxy address.

The default store keeps the counters in memory, for a single instance (with several instances, each one counts on its own). Use a shared store, which increments a counter atomically:

```ts
import type { RateLimitStore } from '@dotpress/auth'

// Redis (ioredis)
const redisStore: RateLimitStore = {
  async increment(key, windowSeconds) {
    const results = await redis
      .multi()
      .set(key, 0, 'EX', windowSeconds, 'NX') // starts a window
      .incr(key)
      .pttl(key)
      .exec()
    return { count: Number(results![1]![1]), resetAt: new Date(Date.now() + Number(results![2]![1])) }
  },
  reset: async (key) => void (await redis.del(key)),
}
```

```sql
-- PostgreSQL: rate_limits (key TEXT PRIMARY KEY, count INT, reset_at TIMESTAMPTZ)
INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2))
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
  reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
RETURNING count, reset_at;
```

`beforeLogin` adds custom policies (CAPTCHA after some failures, blocked addresses…). It is called after the throttle, before the password check:

```ts
createAuth({
  beforeLogin: async ({ username, ipAddress, clientId, req }) => {
    if (await isBlocked(ipAddress)) return forbiddenError('LOGIN_BLOCKED')
  },
})
```

## Access tokens

Access tokens follow [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068): `typ: at+jwt` header, RS256 signature, and the `iss`, `aud`, `sub`, `jti`, `iat`, `exp` and `auth_time` claims, plus `sid` (session, exposed as `ctx.auth.sessionId`) when the token was issued with a refresh token, and `client_id` when it was issued for a client. The type, issuer, audience and client are checked on every request.

The username is not written in the token by default: it is often an email address, readable by anyone holding the token (it is only base64 encoded), in logs and in the browser. `sub` identifies the user, and `ctx.user` holds the profile. `usernameClaim: true` writes it (`ctx.auth.username`).

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
  findUserById: (userId) => db.user.findActivePublicProfile(userId), // undefined for deleted or disabled accounts
  findUserIdentifiers: (username) => db.user.findCredentials(username), // { userId, passwordHash (null without password), role? }
  isSessionRevoked: (sessionId) => …, // optional, see Revocation
  updatePasswordHash: (userId, passwordHash) => db.user.update(userId, { passwordHash }), // optional, see Passwords
}
```

Refresh tokens are random 128-byte values; only their SHA-256 hash is stored.

## Account enumeration

A login fails with the same `401 INVALID_LOGIN` response, in the same time, whether the username is unknown, the account has no password (`passwordHash: null`, for SSO accounts), or the password is wrong: unknown users are checked against a dummy bcrypt hash, computed at startup with `passwordHashRounds`. Two things keep it effective:

- `passwordHashRounds` must match the cost of the hashes stored in your database (see [Passwords](#passwords));
- `onLoginFailed` must do the same work whatever the `errorType` (for example, do not update the user row only on `invalid_password`).

## Passwords

Passwords are hashed with bcrypt, with a cost of 12 by default (`passwordHashRounds`), like Rails and Laravel: about 200 ms per login on a recent laptop with bcryptjs (50 ms with a cost of 10). Measure it on your servers.

**Hash upgrade.** Implement the optional `updatePasswordHash(userId, passwordHash)` method of the data provider: at each successful login, a hash with another cost than `passwordHashRounds` is replaced, computed from the password just verified. Raising the cost then migrates the users as they log in. An error of the method is logged, and does not fail the login.

> While hashes with the previous cost remain, their accounts answer faster than unknown usernames, which reveals that they exist (see [Account enumeration](#account-enumeration)). Either accept it during the migration, or keep `passwordHashRounds` at the cost of your hashes (`10` for hashes created by Dotpress V1).

**72-byte limit.** bcrypt reads the first 72 bytes (UTF-8) of a password, and ignores the rest. `hashPassword()` and `generatePasswordHash()` throw a `RangeError` for longer passwords instead of truncating them. Check the length in the sign-up and password change schemas, so that users get a validation error:

```ts
import { isPasswordTooLong } from '@dotpress/auth'

schema: (z) => ({
  body: z.object({
    password: z.string().min(12).refine((password) => !isPasswordTooLong(password), 'Password too long'),
  }),
})
```

72 bytes are 72 ASCII characters, but fewer with accents or emojis (`é` takes 2 bytes). Logins are not limited: passwords created before the check keep working, as they are compared with the same truncation.

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

## Logout

`POST /auth/logout` revokes the **current session**: the other devices of the user stay logged in. With `{ "scope": "all" }`, it revokes every session of the user, on every device.

The session is identified by the refresh token (cookie, then `refreshToken` body field), or by the access token (`sid` claim). An expired access token does not prevent a logout: the refresh token is enough. The route is idempotent (RFC 7009): an unknown, revoked or missing token still answers `200` and clears the cookies, so that a client can always log out. Only `scope: 'all'` requires a proof, a valid access token or an active refresh token (`401` otherwise). In cookie mode, the refresh token cookie of a cross-origin request gets `403 CROSS_ORIGIN_REQUEST`, like `/auth/refresh`.

Outside the routes, `auth.revokeSession(refreshToken, { scope })` does the same, and returns `{ userId, sessionId }` (or `undefined` when nothing was revoked). `ctx.auth.sessionId` lets an app list the sessions of a user and log out one device (`dataProvider.revokeTokenFamily(sessionId)`).

> **Revoke every session when the password changes or is reset**: call `dataProvider.revokeTokens(userId)`. A stolen session must not survive a password change.

The access tokens of a revoked session stay valid until they expire, unless the data provider implements `isSessionRevoked` (see [Revocation](#revocation)).

## Revocation

Access tokens are verified without a database lookup of the token itself, so revoking a session does not invalidate the access tokens already issued:

| Event | Refresh | Access tokens already issued |
| --- | --- | --- |
| Account deleted or disabled (`findUserById` returns `undefined`) | rejected, the session is revoked | rejected at once |
| Logout, `scope: 'all'`, refresh token reuse, `revokeTokens()` | rejected | valid until they expire (`accessTokenTTL`, 15 minutes), or rejected at once with `isSessionRevoked` |

**`findUserById` must return `undefined` for a deleted, disabled or banned account**: it is called on every authenticated request and every refresh.

### Immediate revocation

Implement the optional `isSessionRevoked(sessionId)` method of the data provider: it is called on every authenticated request carrying a session (`sid` claim), and the tokens of a revoked session get `SESSION_REVOKED` (the request stays anonymous). It costs one lookup per request, besides `findUserById`, and needs a store shared by every instance of the API.

The revocation state is already stored: a revoked session has revoked refresh tokens. With PostgreSQL, query the refresh token table:

```ts
isSessionRevoked: async (sessionId) => {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL LIMIT 1',
    [sessionId]
  )
  return rowCount > 0
}
```

```sql
CREATE INDEX refresh_tokens_family_id ON refresh_tokens (family_id);
```

For faster lookups, record the revoked sessions in Redis when revoking. They only need to be kept for `accessTokenTTL`: afterwards, every access token of the session has expired.

```ts
const ACCESS_TOKEN_TTL = 900 // same as accessTokenTTL
const markRevoked = (familyIds: string[]) =>
  Promise.all(familyIds.map((id) => redis.set(`dotpress:revoked-session:${id}`, '1', { EX: ACCESS_TOKEN_TTL })))

const dataProvider: DataProvider = {
  // …
  revokeTokenFamily: async (familyId) => {
    await db.refreshToken.updateMany({ familyId }, { revokedAt: new Date() })
    await markRevoked([familyId])
  },
  revokeTokens: async (userId) => {
    const familyIds = await db.refreshToken.findActiveFamilyIds(userId)
    await db.refreshToken.updateMany({ userId }, { revokedAt: new Date() })
    await markRevoked(familyIds)
  },
  isSessionRevoked: async (sessionId) => (await redis.exists(`dotpress:revoked-session:${sessionId}`)) === 1,
}
```

An error thrown by `isSessionRevoked` fails closed: the request stays anonymous, and a warning is logged. Avoid caching the answer in the memory of each instance: a revocation would only be seen by the instance that made it, after the cache delay.

## Refresh token rotation

Each refresh returns a new refresh token and invalidates the previous one. All the refresh tokens of a session share a `familyId`, created at login: it is the `sid` claim of the access tokens.

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
