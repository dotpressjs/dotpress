# Migrate from v1

Dotpress 2 is a rewrite. The style of the API stays (`defineRoute()`, `createRouteGroup()`, handlers that return their value), but the framework is no longer built on Express, and there is no compatibility layer. This page lists every change that requires action, in the order of a migration.

:::tip How to migrate
Migrate the app first ([Runtime](#runtime) to [Plugins](#plugins)), with your tests. Then migrate the authentication: its changes reach the clients, the database and the sessions of your users, see [What your users will notice](#what-your-users-will-notice).
:::

## Runtime

- **Node.js 22.12 or later.** Every package declares `"engines": { "node": ">=22.12" }`.
- **ES modules only.** No CommonJS build: CommonJS projects load the packages with `require()`, which Node.js 22.12 supports for ES modules.
- **Zod 4.** Zod 3 is no longer supported. Zod 4 changes some error codes, messages and APIs: see the [Zod 4 changelog](https://zod.dev/v4/changelog).

## Packages

The `dotpress` package is replaced by `@dotpress/core` and an [adapter](/adapters/):

```ts
// v1
import { createApp, defineRoute } from 'dotpress'

// v2
import { createApp, defineRoute } from '@dotpress/core'
import { expressAdapter } from '@dotpress/adapter-express'
```

Express is no longer a dependency of the core. To keep it, install `@dotpress/adapter-express`, which supports Express 4 and 5. You can also move to Fastify, Hono or AWS Lambda without changing your routes.

## Application

### createApp() takes an adapter

`createApp()` returns a Dotpress app, no longer an Express application:

```ts
// v1
const app = await createApp()
app.listen(3000)

// v2
const app = await createApp({ adapter: expressAdapter() })
await app.listen(3000)
```

The Express application is `app.native()`. Call `app.close()` on `SIGTERM`, for a [graceful shutdown](/deployment/node#graceful-shutdown).

### Options

| v1 | v2 |
| --- | --- |
| `useBeforeRoutes: (app) => …` | `expressAdapter({ beforeRoutes: (app) => … })` |
| `useAfterRoutes: (app) => …` | `expressAdapter({ afterRoutes: (app) => … })` |
| `isDev` | `exposeErrors: true`. Dotpress never reads `process.env`. |
| `onException: (err, req) => …` | `onError: (error, ctx) => …`, for every unexpected error |
| `cors: { disable }` | `cors: { origin, credentials }`. Disabled without it. |
| `enableHttpLogging`, `onRequestComplete` | The [`onResponse` hook](/routing/logging#logging-every-request) of a plugin |
| Pino, loaded when installed | `logger: pino()`, passed explicitly. The default logger uses `console`. |

```ts
// v1
await createApp({
  useBeforeRoutes: (app) => app.use(helmet()),
  onException: (err) => Sentry.captureException(err),
})

// v2
await createApp({
  adapter: expressAdapter({ beforeRoutes: (app) => app.use(helmet()) }),
  onError: (error) => Sentry.captureException(error),
})
```

Errors of Dotpress routes never reach the Express error handlers: report them with `onError`. Errors passed to `next(error)` by native middlewares are converted to the Dotpress error format.

### CORS

v1 enabled CORS by default, without an `Access-Control-Allow-Origin` header. In v2, CORS is disabled until you list the allowed origins:

```ts
await createApp({ adapter, cors: { origin: ['https://app.example.com'], credentials: true } })
```

Preflight responses list the methods of the path. An `OPTIONS` request that is not a preflight from an allowed origin gets `405` (or `404`), unless you define an `OPTIONS` route. See [CORS](/routing/http-options#cors).

## Routes

### Path parameters come from the path

The `params: ['id']` form is removed: parameters are typed from the path, group prefixes included.

```ts
// v1
defineRoute({
  path: '/orgs/:orgId/members/:id',
  schema: () => ({ params: ['orgId', 'id'] }),
  handler: async ({ req }) => req.params.id,
})

// v2: req.params is { orgId: string; id: string }
defineRoute({
  path: '/orgs/:orgId/members/:id',
  handler: async ({ req }) => req.params.id,
})
```

A Zod schema can still validate or transform them: `schema: (z) => ({ params: z.object({ id: z.coerce.number() }) })`.

### Paths and matching

- **Only static and `:param` segments.** Wildcards, optional parameters and regular expressions are rejected at startup. Paths and prefixes start with `/`.
- **Case-sensitive**: Express was not, by default.
- **Static segments win**, whatever the declaration order: `/users/me` over `/users/:id`.
- **Conflicts are rejected**: two routes with the same method and path make `createApp()` throw.
- Express settings (`case sensitive routing`, `strict routing`, `query parser`) do not apply to Dotpress routes.

See [Paths](/routing/routes#paths).

### Routers replace the test helpers

| v1 | v2 |
| --- | --- |
| `$clearRoutes()`, `$clearResponseFilters()` | `globalRouter.clear()`, or better, an explicit router per test |
| `getAllRoutes()` | `app.routes` |
| `getResponseFilters()` | — (the filters are passed to `createApp()`, a router or a plugin) |
| Response filters, global | `createApp({ responseFilters })`, `router.addResponseFilter()`, or the global `addResponseFilter()` |

`defineRoute()` and `createRouteGroup()` still register on a global router, mounted when `createApp()` has no `routers`. `createRouter()` creates explicit routers: see [Routers](/routing/routes#routers).

## Handlers

### ctx.req and ctx.res are no longer Express objects

They are the same on every adapter:

- `ctx.req`: `method`, `path`, `url`, typed `params`, `query`, `body` and `files`, `headers` (lowercase names), `cookies`, `ip`, `signal`, `header(name)`;
- `ctx.res`: `setStatus()`, `setHeader()`, `appendHeader()`, `removeHeader()`, `setCookie()`, `clearCookie()`.

The native request is `ctx.raw`, as an escape hatch. `cookie-parser` is no longer needed: `ctx.req.cookies` is always there. See [Request context](./context).

### Handlers return the response

A handler can no longer write the response itself:

```ts
// v1
handler: async ({ res }) => {
  res.status(201).json({ id })
}

// v2
handler: async ({ res }) => {
  res.setStatus(201) // or `status: 201` on the route
  return { id }
}
```

| v1 | v2 |
| --- | --- |
| `res.json(data)` | `return data`, or `return json(data, { status, headers })` |
| `res.send('OK')` | `return text('OK')` |
| `res.redirect('/login')` | `return redirect('/login')` |
| `res.download()`, `res.sendFile()` | `return file(bytes, { filename, contentType })` |
| `res.write()` | `return stream(source)`, or `return sse(source)` for Server-Sent Events |
| `res.status(204).end()` | `return` nothing, or `return empty()` |

**Returning nothing always responds `204`.** In v1, it did only with a `z.never()` response schema, and sent no response otherwise. See [Responses](/routing/responses).

`ctx.req.signal` is aborted when the client disconnects: pass it to long work, and streams stop with it.

## Middlewares

### They run before validation

v1 validated the request, then ran the middlewares. v2 runs the middlewares first:

1. middlewares: plugins, app, groups, route;
2. request validation;
3. the handler;
4. response validation, then the response filters.

Two consequences:

- an anonymous request with an invalid body now gets the `401` of the authentication middleware, not a `400`;
- middlewares see the raw `params`, `query` and `body`. Only handlers see the parsed values.

### Their return value is checked

A middleware returns nothing to continue, or an `HttpError` or a response helper (`redirect()`…) to stop the request. Any other value is a bug, and gives a `500`.

## Errors

### One format

Every error, `404` and `500` included, has the same body. Clients that read the `code` key of the v1 framework errors must read `error`:

```json
{ "status": 404, "error": "NOT_FOUND", "message": "Route not found" }
```

| Request | v1 | v2 |
| --- | --- | --- |
| No route | `404`, `code` key, `No matching route.` | `404 NOT_FOUND`, `Route not found` |
| Path exists, other method | `404` | `405 METHOD_NOT_ALLOWED`, with an `Allow` header |
| Invalid JSON body | `500` | `400 MALFORMED_BODY` |
| `throw notFoundError()` | `500 INTERNAL_ERROR` | `404`, like `return notFoundError()` |
| Body too large | beyond 100 KB | `413 PAYLOAD_TOO_LARGE`, beyond 1 MiB |
| Compressed body | — | `415 UNSUPPORTED_MEDIA_TYPE` |

The error helpers and `new HttpError()` take the details of the body in an options object, with the original error: `notFoundError('Task not found', { data: { id }, cause })`. See [Responses and errors](./responses#errors-produced-by-dotpress).

### Validation errors

The issues are a flat list, each with its source:

```json
// v1
{
  "error": "Validation failed",
  "details": [{ "source": "body", "issues": [{ "path": ["name"], "code": "invalid_type", "message": "…" }] }]
}

// v2
{
  "status": 400,
  "error": "VALIDATION_FAILED",
  "message": "Validation failed",
  "data": { "issues": [{ "source": "body", "path": ["name"], "code": "invalid_type", "message": "…" }] }
}
```

Codes and messages come from Zod 4, unchanged.

## Request bodies

v1 parsed JSON only, with the defaults of `express.json()`. Every adapter of v2 parses bodies the same way:

| Content type | `req.body` |
| --- | --- |
| `application/json`, `*+json` | the parsed JSON |
| `application/x-www-form-urlencoded` | strings, repeated keys giving arrays |
| `multipart/form-data` | the text fields, files in `req.files` |
| `text/*` | a string |
| anything else | a `Uint8Array` |
| no body | `undefined` (v1: `{}`) |

- **The limit is 1 MiB** (v1: 100 KB): `bodyLimit` on the adapter, or on a route.
- **The query string is parsed like a form**: `a[b]=1` is no longer expanded into objects.
- **Webhook signatures**: `rawBody: true` on the route gives `req.rawBody`, without a custom `express.json({ verify })`.

## File uploads

Multer is no longer used. Files are validated by a `files` schema, and received as Web `File` objects:

```ts
// v1
defineRoute({
  method: 'post',
  path: '/avatar',
  files: { avatar: { maxSize: 2_000_000, mimeTypes: ['image/png'], extensions: ['.png'] } },
  handler: async ({ getFile }) => {
    const avatar = getFile('avatar') // MulterFile | undefined
  },
})

// v2
defineRoute({
  method: 'post',
  path: '/avatar',
  bodyLimit: 3_000_000,
  schema: (z) => ({
    files: z.object({
      avatar: z
        .file()
        .max(2_000_000)
        .mime(['image/png'])
        .refine((file) => file.name.endsWith('.png'), 'Invalid extension'),
    }),
  }),
  handler: async ({ req }) => {
    const bytes = new Uint8Array(await req.files.avatar.arrayBuffer())
  },
})
```

- Invalid files give the usual `400 VALIDATION_FAILED`, with `source: 'files'` issues.
- Uploads count in the body limit: raise `bodyLimit` on upload routes.
- A repeated field gives an array of files: `arrayOf()` always gives an array.
- Files are kept in memory, as with the `memoryStorage` of v1.

See [File uploads](/routing/bodies#file-uploads).

## Plugins

Plugins are objects, declared with `definePlugin()`:

```ts
// v1
const myPlugin: Plugin = (api) => {
  api.addRoute({ … })
}

// v2
const myPlugin = definePlugin({
  name: 'my-plugin',
  dependsOn: ['auth'], // optional
  async setup(api) {
    api.defineRoute({ … })
  },
})
```

| v1 | v2 |
| --- | --- |
| `api.addRoute()` | `api.defineRoute()` |
| `api.addGroup()` | `api.createGroup()` |
| `api.useBeforeRoutes()`, `api.useAfterRoutes()` | Removed: a plugin does not depend on an adapter |
| Registration at any time | During `setup()` only |
| — | `decorateContext()`, `onError()`, `hooks` (`onInit`, `onReady`, `onRequest`, `wrapRequest`, `onResponse`, `onClose`), `getRoutes()`, `getPlugin()`, `logger` |

Plugin names are unique; missing or circular dependencies make `createApp()` throw. See [Plugin API](./plugins).

## Typing

`AppTypes` is replaced by module augmentation. The user type is declared on `AuthUser`, and other keys on `RequestContext`:

```ts
// v1
declare module 'dotpress' {
  interface AppTypes {
    user: User
  }
}

// v2
declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
    roles: string[]
  }
}
```

The augmentation of the Express `Request` (`id`, `files`, `user`) is removed: use `ctx.requestId`, `ctx.req.files` and `ctx.user`. See [Typing](/concepts/typing).

## Authentication

### The service and the plugin

`configurePlugin(settings)` is replaced by a service, `createAuth(settings)`, given to the app with `authPlugin(auth)`. The service also works without an app, in scripts and workers.

```ts
// v1
const app = await createApp({ plugins: [configurePlugin({ keys, dataProvider })] })

// v2
const auth = createAuth({ keys, dataProvider, issuer: 'https://api.example.com' })
const app = await createApp({ adapter: expressAdapter(), plugins: [authPlugin(auth)] })
```

| v1 | v2 |
| --- | --- |
| `generateTokensForUser()`… | Methods of the service, asynchronous: `await auth.generateTokensForUser({ userId })` |
| `generateAccessToken()` | Removed: a token without session could not be revoked. `generateTokensForUser()` issues a token pair in a new session. |
| `revokeTokens(userId)` of your data provider, to log a user out everywhere | `await auth.revokeUserSessions(userId)` |
| `setAuthCookies(res, tokens)`, `clearAuthCookies(res)` | `auth.setAuthCookies(ctx.res, tokens)`, `auth.clearAuthCookies(ctx.res)` |
| `req.user` | `ctx.user`, and the token in `ctx.auth` |
| — | `requireAuth`, `requireRole(...roles)`, `requireClient(...clientIds)` |
| `refreshTokenTTLInDays: 14` | `session: { idleTimeout: '14d' }`, and `session.absoluteTimeout` |
| `aud` setting, login field `aud` or `client` | `clients: { allowed, required?, isUserRoleAllowed? }`, login field `clientId` |
| The routes under `/auth` | Unchanged; `authPlugin(auth, { prefix })` to move them, `{ routes: false }` to remove them |

### Settings to change

- **`issuer` is required**, and the `iss` claim is checked: one value per environment and application, such as the URL of the API.
- **`keys.secretKey` is renamed `keys.privateKey`.**
- **Unknown settings are rejected**: a misspelled setting throws at startup instead of being ignored. The setting types are named `AuthOptions`, `AuthCookieOptions`, `SessionOptions`…
- **Keys in PKCS#8 and SPKI.** PKCS#1 keys (`BEGIN RSA PRIVATE KEY`) make `createApp()` fail. Converting a key does not change it: existing tokens stay valid.

  ```sh
  openssl pkcs8 -topk8 -nocrypt -in private.pem -out private.pkcs8.pem
  openssl rsa -RSAPublicKey_in -in public.pem -pubout -out public.spki.pem
  ```

- **Only RS256** is accepted.
- **The `secure` flag of cookies is `true` by default** (v1: only when `NODE_ENV` is `production`). Browsers accept secure cookies on `http://localhost`.
- **In cookie mode, list the origins of your app** if it is not served from the API origin: in the `cors` option with `credentials: true`, or in `cookies.trustedOrigins`. Cross-site requests from other origins are no longer authenticated by the cookie. See [Cookie mode and CSRF](/auth/cookies#protection-against-cross-site-request-forgery).

### The data provider

| Method | Change |
| --- | --- |
| `storeRefreshToken(payload)` | The payload has a `sessionId`, to store. `jwtId` is renamed `accessTokenId`. The token itself is not given: store its `tokenHash`. |
| `findRefreshToken(tokenHash)` | Returns `accessTokenId` (v1 `jwtId`), and the stored `sessionId` and `usedAt`. |
| `markRefreshTokenAsUsed(tokenHash, usedAt)` | New `usedAt` parameter, to store. |
| `revokeTokens(userId)` | Renamed `revokeUserTokens(userId)`. |
| `revokeSessionTokens(sessionId)` | New, required: revokes every refresh token of a session. |
| `findUserById(id)` | Returns an `AuthUser`, and `undefined` for deleted, disabled or banned accounts: their sessions are no longer refreshed. |
| `isSessionRevoked(sessionId)` | New, optional: rejects the access tokens of a revoked session at once. |
| `updatePasswordHash(userId, hash)` | New, optional: upgrades the hashes of another cost at login. |

For an SQL table:

```sql
ALTER TABLE refresh_tokens ADD COLUMN session_id VARCHAR(36) NULL;
ALTER TABLE refresh_tokens ADD COLUMN used_at TIMESTAMP NULL; -- the type of expires_at: TIMESTAMPTZ on PostgreSQL
CREATE INDEX refresh_tokens_session_id ON refresh_tokens (session_id);
```

Your columns keep their names: map `jwt_id` to `accessTokenId`. Refresh tokens stored by v1 keep working: they start a session at their next rotation. See [Data provider](/auth/data-provider).

### New defaults

| | v1 | v2 | To keep v1 |
| --- | --- | --- | --- |
| Access token lifetime | 1 hour | 15 minutes | `accessTokenTTL: 3600` |
| bcrypt cost | 10 | 12 | `passwordHashRounds: 10` |
| Login throttling | none | 5 failures per minute per username and IP, 100 per hour per username | `loginThrottle: false` |
| Logout | every session of the user | the current session | `{ "scope": "all" }` in the body |
| `username` claim | written | not written | `usernameClaim: true` |
| Refresh token reuse | rejected | revokes the session (after 10 seconds of grace) | — |
| Refresh token cookie | `SameSite` setting, `Path=/` | `SameSite=Strict`, `Path=/auth` | `cookies.refreshTokenSameSite`, `cookies.refreshTokenPath` |

- **Throttling**: the default store is in memory. With several instances, configure a [shared store](/auth/passwords#a-shared-store). Behind a proxy, the server must trust the proxy headers, or every client shares one counter per username.
- **Passwords over 72 bytes** make `hashPassword()` throw, where bcrypt truncated them: check new passwords with `isPasswordTooLong()` in your schemas. Existing passwords keep working.
- **Without the `username` claim**, `ctx.auth.username` is `undefined`: use `ctx.user`, or `GET /auth/me` in the frontend.
- **Client IP addresses** of the login events come from `ctx.req.ip`: proxy headers count only when the server trusts them (v1 trusted them always, so addresses could be spoofed).

### Responses of the routes

- **Tokens set as cookies are no longer in the body.** With the refresh token in a cookie, the body has the `accessToken` only; with both in cookies, no token. `userId`, `expiresIn` and `expiresAt` are always there.
- **The access token is read from the `Authorization: Bearer` header** (or its cookie), no longer from an `accessToken` field of the body. Send the header on `/auth/logout` too. `/auth/refresh` still reads its body as before.
- **Errors**: an invalid token on `/auth/refresh` or `/auth/restore` gives `401 INVALID_REFRESH_TOKEN` (v1: `500`). New: `429 TOO_MANY_LOGIN_ATTEMPTS`, with `Retry-After`, and `403 CROSS_ORIGIN_REQUEST`.
- **Logout is idempotent**: without a valid token, it answers `200` and clears the cookies (v1: `401`).
- **`onLoginFailed`** has a new `errorType`, `'too_many_attempts'`: an exhaustive `switch` needs a case. Its events report `clientId` instead of `client`.

### Access tokens

Access tokens follow [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068):

| | v1 | v2 |
| --- | --- | --- |
| `typ` header | `JWT` | `at+jwt` |
| `iss` | empty by default, not checked | `issuer`, checked |
| `aud` | the client given at login, not checked | the API (`audience`, `issuer` by default), checked |
| Client | `aud` | `client_id`, in `ctx.auth.clientId` |
| Session | — | `sid`, in `ctx.auth.sessionId` |

Services that verify the tokens themselves must accept the new `aud`, and the `at+jwt` type if they check it.

## What your users will notice

| Change | Effect | To avoid it |
| --- | --- | --- |
| New access token format | v1 access tokens are rejected (`401`). Clients refresh as usual and get v2 tokens: sessions continue. | — |
| New cookie names (`__Host-`, `__Secure-`) and path | Users of the cookie mode are logged out once. | Keep the v1 names and path, below. |
| bcrypt cost of 12 | Logins take about 200 ms instead of 50 ms. Accounts still hashed with a cost of 10 answer faster than unknown usernames, until they log in again. | `passwordHashRounds: 10` |
| Shorter access tokens | Clients refresh every 15 minutes. | `accessTokenTTL: 3600` |

To keep the sessions of the cookie mode:

```ts
cookies: {
  enabled: true,
  accessTokenName: 'dotpress_access_token',
  refreshTokenName: 'dotpress_refresh_token',
  refreshTokenPath: '/',
}
```

Do not change the path of the refresh token cookie without renaming it: the browser would keep both cookies, and send both.

## Checklist

- [ ] Node.js 22.12 or later, Zod 4.
- [ ] `@dotpress/core` and an adapter installed; `dotpress` removed.
- [ ] `createApp({ adapter })`; Express middlewares in `beforeRoutes` and `afterRoutes`.
- [ ] `onError` instead of `onException`, `exposeErrors` instead of `isDev`, and the `cors` origins listed.
- [ ] `params: [...]` removed; Express path syntax replaced.
- [ ] Handlers return their response: no `res.json()`, `res.send()` or `res.redirect()`.
- [ ] Middlewares checked: they see the raw request, and return nothing, an error or a response.
- [ ] Clients read the `error` key of errors, and the new validation format.
- [ ] Uploads: `files` schemas, `bodyLimit` on upload routes.
- [ ] Plugins declared with `definePlugin()`.
- [ ] `AppTypes` replaced by `AuthUser` and `RequestContext` augmentations.
- [ ] Auth: `createAuth()` with `issuer`, PKCS#8 and SPKI keys, the new data provider methods and columns.
- [ ] Auth: the new defaults reviewed (lifetimes, cost, throttling, logout, cookies).
- [ ] Clients send the access token in the `Authorization` header, and no longer read tokens set as cookies from the body.
- [ ] With several instances: a shared store for the login throttling.
