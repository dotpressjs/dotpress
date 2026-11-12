# Data provider

`@dotpress/auth` stores nothing itself. A data provider, an object of a few functions, reads your users and stores the refresh tokens in your database, with the library of your choice.

## The methods

| Method | Required | Called |
| --- | --- | --- |
| `findUserIdentifiers(username)` | ✓ | At login: `{ userId, passwordHash, role? }`, or `undefined` for an unknown username. `passwordHash` is `null` for an account without password (SSO). |
| `findUserById(userId)` | ✓ | On every authenticated request and every refresh: the user, which becomes `ctx.user` |
| `storeRefreshToken(token)` | ✓ | At login and at each refresh |
| `findRefreshToken(tokenHash)` | ✓ | At each refresh and logout |
| `markRefreshTokenAsUsed(tokenHash, usedAt)` | ✓ | At each refresh |
| `revokeTokenFamily(familyId)` | ✓ | At logout, and when a stolen refresh token is detected: revokes one session |
| `revokeTokens(userId)` | ✓ | At logout of every device: revokes every session of the user |
| `isSessionRevoked(sessionId)` | | On every authenticated request: rejects the access tokens of a revoked session at once, see [Revocation](./sessions#revocation) |
| `updatePasswordHash(userId, passwordHash)` | | After a successful login, when the cost of the hash changed, see [Passwords](./passwords#raising-the-cost) |

:::warning findUserById decides who is logged in
`findUserById()` must return `undefined` for a deleted, disabled or banned account. It is called on every request: the user is logged out at once, and their sessions are revoked at the next refresh.
:::

Return only what the handlers need from `findUserById()`: it becomes `ctx.user`, and is returned by `GET /auth/me`. Never the password hash.

## The refresh tokens table

A refresh token is stored by its SHA-256 hash, never in clear. The tokens of a session share a `familyId`, the session ID:

```sql
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  jwt_id TEXT NOT NULL,
  family_id TEXT NOT NULL, -- the session
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  revoked_at TIMESTAMP
);
CREATE INDEX refresh_tokens_family_id ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_id ON refresh_tokens (user_id);
```

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
