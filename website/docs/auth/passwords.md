# Passwords and brute force

## Hashing

Passwords are hashed with bcrypt, with a cost of **12** by default (`passwordHashRounds`), like Rails and Laravel: about 200 ms per login on a recent laptop. Measure it on your servers: the cost slows down an attacker who stole the hashes, and your logins too.

```ts
const passwordHash = await auth.hashPassword(password) // at sign-up
const valid = await auth.verifyPassword(password, passwordHash)
```

`generatePasswordHash(password, { rounds })` hashes without an auth service, in a script that creates accounts. Like `hashPassword()`, it throws a `RangeError` beyond 72 bytes.

### The 72-byte limit

bcrypt reads the first 72 bytes of a password, in UTF-8, and ignores the rest. Rather than truncating silently, `hashPassword()` throws a `RangeError` for longer passwords. Check the length in the schemas of sign-up and password change, so that users get a validation error:

```ts twoslash
import { isPasswordTooLong } from '@dotpress/auth'
import { z } from 'zod'
// ---cut---
const Password = z
  .string()
  .min(12)
  .refine((password) => !isPasswordTooLong(password), 'Password too long')
```

72 bytes are 72 ASCII characters, fewer with accents or emojis (`é` takes 2 bytes). Logins are not limited: passwords created before the check keep working.

### Choosing the rules

Follow the NIST guidelines (SP 800-63B): require long passwords rather than complex ones (no forced mix of digits and symbols, no periodic change), accept spaces and any character, and reject passwords known to have leaked, for instance with the k-anonymity API of [Have I Been Pwned](https://haveibeenpwned.com/API/v3#PwnedPasswords).

### Raising the cost

Implement the optional `updatePasswordHash(userId, passwordHash)` method of the data provider: at each successful login, a hash with another cost than `passwordHashRounds` is replaced by a new one, computed from the password just verified. Raising the cost then upgrades the users as they log in. An error of the method is logged, and does not fail the login.

While hashes with the previous cost remain, their accounts answer faster than unknown usernames, which reveals that they exist (see below). Accept it during the migration, or keep `passwordHashRounds` at the cost of your hashes (`10` for hashes created by Dotpress 1).

## Account enumeration

A failed login gets the same `401 INVALID_LOGIN` response, in the same time, whether the username is unknown, the account has no password, or the password is wrong: unknown users are checked against a dummy hash, computed at startup with `passwordHashRounds`. An attacker cannot learn which usernames exist. Two things keep it effective:

- `passwordHashRounds` must match the cost of the hashes in your database;
- `onLoginFailed` must do the same work whatever the `errorType`: do not update the user row only on `invalid_password`.

Apply the same care to your own routes: a sign-up that answers "email already used", or a password reset that answers "unknown email", reveals the accounts. Answer the same way, and send an email instead.

## Brute force protection

Failed logins are throttled by default, before the password is checked:

| Counter | Default | Against |
| --- | --- | --- |
| username + IP address | 5 per minute | brute force from one client, without letting others lock the account |
| username | 100 per hour | distributed brute force on one account |

Over a limit, the login answers `429 TOO_MANY_LOGIN_ATTEMPTS` with a `Retry-After` header, and `onLoginFailed` gets `errorType: 'too_many_attempts'`. Attempts are counted whether the account exists or not, so a `429` reveals nothing. A successful login clears the counter of the client. Usernames are normalized (letter case, spaces), and the keys of the counters are hashed.

```ts
createAuth({
  loginThrottle: {
    store: redisStore, // see below
    limits: { usernameAndIp: { max: 10, window: 60 }, username: false },
  },
})
```

:::warning Behind a proxy
The IP address comes from the HTTP server. Behind a load balancer or a reverse proxy, configure the server to trust the proxy headers (Express `trust proxy`, Fastify `trustProxy`, Hono `getIp`): otherwise every client shares the address of the proxy, and one attacker locks out everyone on a username. See [Client IP address](/routing/http-options#client-ip-address-behind-a-proxy).
:::

### A shared store

The default store, `createMemoryRateLimitStore()`, keeps the counters in memory: with several instances of the API, each one counts on its own. Use a shared store, which increments a counter atomically. `RateLimitStore` is the contract of `@dotpress/core`, so a store can serve other rate limits of your app too:

```ts
import type { RateLimitStore } from '@dotpress/core'

// Redis (ioredis)
const redisStore: RateLimitStore = {
  async increment(key, windowSeconds) {
    const results = await redis
      .multi()
      .set(key, 0, 'EX', windowSeconds, 'NX') // starts a window
      .incr(key)
      .pttl(key)
      .exec()
    return {
      count: Number(results![1]![1]),
      resetAt: new Date(Date.now() + Number(results![2]![1])),
    }
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

`loginThrottle: false` disables the protection, only when the infrastructure (an API gateway, a WAF) already limits `/auth/login`.

### Custom policies

`beforeLogin` runs after the throttle and before the password check: return an error to reject the attempt (a blocked address, a CAPTCHA required after some failures…).

```ts
createAuth({
  beforeLogin: async ({ username, ipAddress, clientId, req }) => {
    if (await blockedAddresses.has(ipAddress)) return forbiddenError('LOGIN_BLOCKED')
  },
})
```

## Login events

`onLoginSuccess` and `onLoginFailed` receive each attempt, with the username, the client and the IP address: feed your security logs and alerts with them.
