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
  issuer: 'https://api.example.com',
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
| `POST /auth/login` | `{ username, password, client?, aud?, mode? }` → token pair. `mode: 'cookie'` also sets the cookies. |
| `POST /auth/refresh` | Rotates a token pair, sent in the body or as cookies. |
| `GET /auth/me` | Authenticated user. |
| `POST /auth/restore` | Restores a cookie session (requires `cookies.accessTokenInCookie`). |
| `POST /auth/logout` | Revokes the refresh tokens of the user and clears the cookies. |

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

`requireAuth` answers `401`; `requireRole()` answers `401` without user and `403` without one of the roles. In the handlers of guarded routes, `ctx.user` and `ctx.auth` are typed as defined. Roles come from the user `roles` array (or `role` string), or from the `getUserRoles` setting.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `keys` | — | RSA key pair: `secretKey` (PKCS#8 PEM) and `publicKey` (SPKI PEM). Tokens are signed with RS256. |
| `dataProvider` | — | Storage of users and refresh tokens. |
| `accessTokenTTL` | `3600` | Access token lifetime, in seconds. |
| `refreshTokenTTLInDays` | `14` | Refresh token lifetime, in days. |
| `issuer` | `''` | `iss` claim. |
| `cookies` | disabled | Cookie mode: `enabled`, `httpOnly` (`true`), `secure` (`true`), `sameSite` (`lax`), `domain`, `path` (`/`), `accessTokenName`, `refreshTokenName`, `accessTokenInCookie` (`false`). |
| `aud` | — | `{ required?, isUserRoleAllowed(role, aud) }`: audience checked at login. |
| `onLoginSuccess` / `onLoginFailed` | — | Login events (user, client, IP address). |
| `getUserRoles` | `user.roles` / `user.role` | Roles checked by `requireRole()`. |

To convert PKCS#1 keys (`BEGIN RSA PRIVATE KEY`):

```sh
openssl pkcs8 -topk8 -nocrypt -in private.pem -out private.pkcs8.pem
openssl rsa -RSAPublicKey_in -in public.pem -pubout -out public.spki.pem # BEGIN RSA PUBLIC KEY only
```

## Data provider

```ts
import type { DataProvider } from '@dotpress/auth'

const dataProvider: DataProvider = {
  storeRefreshToken: ({ tokenHash, userId, jwtId, expiresAt }) => db.refreshToken.create({ … }),
  findRefreshToken: (tokenHash) => db.refreshToken.find({ tokenHash }),
  markRefreshTokenAsUsed: (tokenHash) => db.refreshToken.update({ tokenHash }, { isUsed: true }),
  revokeTokens: (userId) => db.refreshToken.updateMany({ userId }, { revokedAt: new Date() }),
  findUserById: (userId) => db.user.findPublicProfile(userId),
  findUserIdentifiers: (username) => db.user.findCredentials(username), // { userId, passwordHash, role? }
}
```

Refresh tokens are random 128-byte values; only their SHA-256 hash is stored.

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
