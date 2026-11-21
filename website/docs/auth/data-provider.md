# Data provider

`@dotpress/auth` stores nothing itself. A data provider, an object of a few functions, reads your users and stores the refresh tokens in your database, with the library of your choice.

## The methods

| Method | Required | Called |
| --- | --- | --- |
| `findUserIdentifiers(username)` | ✓ | At login: `{ userId, passwordHash, role? }`, or `undefined` for an unknown username. `passwordHash` is `null` for an account without password (SSO). |
| `findUserById(userId)` | ✓ | On every authenticated request and every refresh: the user, which becomes `ctx.user` |
| `storeRefreshToken(payload)` | ✓ | At login and at each refresh: `{ tokenHash, userId, accessTokenId, sessionId, expiresAt }`. The token itself is never given: only its SHA-256 hash. |
| `findRefreshToken(tokenHash)` | ✓ | At each refresh and logout: `{ userId, accessTokenId, sessionId, expiresAt, isUsed, usedAt, revokedAt }`, or `undefined`. `isUsed` can be derived from `usedAt`. |
| `markRefreshTokenAsUsed(tokenHash, usedAt)` | ✓ | At each refresh |
| `revokeSessionTokens(sessionId)` | ✓ | At logout, and when a stolen refresh token is detected: revokes one session |
| `revokeUserTokens(userId)` | ✓ | At logout of every device, and by `auth.revokeUserSessions(userId)`: revokes every session of the user |
| `isSessionRevoked(sessionId)` | | On every authenticated request: rejects the access tokens of a revoked session at once, see [Revocation](./sessions#revocation) |
| `updatePasswordHash(userId, passwordHash)` | | After a successful login, when the cost of the hash changed, see [Passwords](./passwords#raising-the-cost) |

:::warning findUserById decides who is logged in
`findUserById()` must return `undefined` for a deleted, disabled or banned account. It is called on every request: the user is logged out at once, and their sessions are revoked at the next refresh.
:::

Return only what the handlers need from `findUserById()`: it becomes `ctx.user`, and is returned by `GET /auth/me`. Never the password hash.

## The refresh tokens table

A refresh token is stored by its SHA-256 hash, never in clear. The tokens of a session share a `sessionId`, the session ID:

```sql
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access_token_id TEXT NOT NULL,
  session_id TEXT NOT NULL, -- the session
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX refresh_tokens_session_id ON refresh_tokens (session_id);
CREATE INDEX refresh_tokens_user_id ON refresh_tokens (user_id);
```

The dates are instants: on PostgreSQL, store them as `TIMESTAMPTZ`. A `TIMESTAMP` column has no time zone, and drivers like `pg` write dates in the time zone of the process: when the API does not run in UTC, the dates compared with `now()` in SQL are off by its offset. On MySQL, `TIMESTAMP` is stored in UTC.

Expired tokens can be deleted by a scheduled job: `DELETE FROM refresh_tokens WHERE expires_at < now()`.

## An SQL data provider

The data provider of the [Tasks API example](/examples/tasks-api), on SQLite. The queries are the same on PostgreSQL or MySQL, with their placeholders:

```ts file="<root>/../examples/tasks-api/src/features/auth/data-provider.ts"
```

`findUserById()` and `findUserIdentifiers()` come from the users repository of the app: the user table stays yours, with your columns.

## The type of the user

The type of `ctx.user` is the `AuthUser` interface, which you complete once, with module augmentation:

```ts
declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
    email: string
    roles: string[]
  }
}
```

`findUserById()` must return this type. See [Protecting routes](./protecting-routes#the-type-of-the-user).

## In tests

A data provider over a `Map` is enough for the tests. The [Auth example](/examples/auth) has one, in `src/store.ts`, used both by the app in development and by the tests.
