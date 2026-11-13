# Sessions and tokens

A session starts at login, and lives as long as its refresh tokens are renewed. This page covers the tokens, the lifetimes, the logout and the revocation of sessions.

## Access tokens

Access tokens are JWTs following [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068), signed with RS256:

- the header has `typ: at+jwt`, so that another JWT signed with the same key (an ID token) is not accepted as an access token;
- the claims are `iss`, `aud`, `sub`, `jti`, `iat`, `exp` and `auth_time`, plus `sid` (the session) and `client_id` (the client, with the [`clients` setting](./clients));
- the type, issuer, audience and client are checked on every request.

They are valid **15 minutes** (`accessTokenTTL: 900`). A short lifetime limits the use of a leaked token, and of the tokens of a revoked session (see [Revocation](#revocation)).

The username is not written in the token: it is often an email address, and a JWT is only encoded, readable by anyone who holds it, in logs and browsers. `sub` identifies the user, and `ctx.user` holds the profile. `usernameClaim: true` writes it if you need it.

## Refresh token rotation

A refresh token is a random 128-byte value. Each refresh returns a new one and invalidates the previous one: **a refresh token is used once**.

When a used refresh token comes back, it was probably stolen: the attacker and the legitimate client both hold it. The whole session is revoked, including the tokens the attacker obtained, `onRefreshTokenReuse` is called, and the request gets `401 INVALID_REFRESH_TOKEN`.

```ts
createAuth({
  // …
  onRefreshTokenReuse: ({ userId, familyId }) => {
    securityLog.warn({ userId, sessionId: familyId }, 'Refresh token reused: session revoked')
  },
})
```

Within 10 seconds after its first use (`refreshTokenReuseInterval`), a token presented again gets a new pair in the same session, like with Auth0 or Okta: concurrent refreshes from several tabs, and retries after a lost response, keep working.

## Session lifetimes

A session ends after one of two timeouts, in seconds:

| Setting | Default | The session ends… |
| --- | --- | --- |
| `session.idleTimeout` | 14 days | when it is not refreshed during this delay |
| `session.absoluteTimeout` | none | this delay after login, even when it is active |

```ts
const DAY = 24 * 60 * 60

session: { idleTimeout: 30 * DAY } // consumer app: never logged out while active
session: { idleTimeout: DAY, absoluteTimeout: DAY } // backoffice: log in every day
session: { idleTimeout: 7 * DAY, absoluteTimeout: 28 * DAY } // log in every 4 weeks
```

With an absolute timeout, no token or cookie outlives the session, and the responses return `sessionExpiresAt`, so that the client can warn the user. An ended session makes `/auth/refresh` answer `401 EXPIRED_REFRESH_TOKEN`: the user logs in again.

:::tip
Applications with privileged users (backoffices, admin consoles) should have an absolute timeout: a session stolen from an admin then ends within the day. Each [client](./clients#session-lifetimes-per-client) can have its own lifetimes.
:::

## Logout

`POST /auth/logout` revokes the **current session**: the other devices of the user stay logged in. With `{ "scope": "all" }`, it revokes every session of the user.

- The session is identified by the refresh token (cookie, or `refreshToken` field), or by the access token. An expired access token does not prevent a logout.
- The route is idempotent (RFC 7009): an unknown or missing token still answers `200` and clears the cookies, so that a client can always log out. Only `scope: 'all'` requires a valid access token or an active refresh token, and answers `401` without.

Outside the routes, `auth.revokeSession(refreshToken, { scope })` does the same. `ctx.auth.sessionId` lets an app list the sessions of a user, and log out one device with `dataProvider.revokeTokenFamily(sessionId)`.

## Revoke every session after a password change

:::warning
When a password is changed or reset, revoke every session of the user: a stolen session must not survive the change.
:::

From the [Auth example](/examples/auth):

```ts
await store.users.setPasswordHash(user.id, await auth.hashPassword(req.body.newPassword))
// A stolen session must not survive a password change.
await auth.settings.dataProvider.revokeTokens(user.id)
```

Do the same when an account is disabled, or when the email address changes.

## Revocation

The access tokens are verified without a database lookup: revoking a session does not invalidate the access tokens already issued.

| Event | Refresh | Access tokens already issued |
| --- | --- | --- |
| Account deleted or disabled (`findUserById` returns `undefined`) | rejected, the session is revoked | rejected at once |
| Logout, `scope: 'all'`, refresh token reuse, `revokeTokens()` | rejected | valid until they expire (15 minutes), or rejected at once with `isSessionRevoked` |

### Immediate revocation

Implement the optional `isSessionRevoked(sessionId)` method of the data provider: the access tokens of a revoked session are rejected at once (the request stays anonymous). It costs one lookup per authenticated request, in a store shared by every instance of the API.

The revoked sessions are already in the refresh tokens table:

```ts
isSessionRevoked: async (sessionId) => {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL LIMIT 1',
    [sessionId]
  )
  return rowCount > 0
}
```

For faster lookups, record the revoked sessions in Redis when revoking them, for `accessTokenTTL` only: afterwards, every access token of the session has expired.

```ts
const ACCESS_TOKEN_TTL = 900 // same as accessTokenTTL
const markRevoked = (familyIds: string[]) =>
  Promise.all(familyIds.map((id) => redis.set(`revoked-session:${id}`, '1', { EX: ACCESS_TOKEN_TTL })))

const dataProvider: DataProvider = {
  // …
  revokeTokenFamily: async (familyId) => {
    await db.refreshTokens.revokeFamily(familyId)
    await markRevoked([familyId])
  },
  revokeTokens: async (userId) => {
    const familyIds = await db.refreshTokens.activeFamilyIds(userId)
    await db.refreshTokens.revokeUser(userId)
    await markRevoked(familyIds)
  },
  isSessionRevoked: async (sessionId) => (await redis.exists(`revoked-session:${sessionId}`)) === 1,
}
```

An error thrown by `isSessionRevoked` fails closed: the request stays anonymous, and a warning is logged. Do not cache the answer in the memory of each instance: a revocation would only be seen by the instance that made it.
