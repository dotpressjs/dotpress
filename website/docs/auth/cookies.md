# Cookie mode and CSRF

For browser applications, keep the tokens in `httpOnly` cookies. The JavaScript of the page never sees them: a script injected in the page (XSS) cannot steal them, while a token stored in `localStorage` or in memory can be read and sent anywhere.

## Enable it

```ts
const auth = createAuth({
  // …
  cookies: { enabled: true, accessTokenInCookie: true },
})
```

The browser logs in with `mode: 'cookie'`, and sends the cookies with each request:

```ts
// In the browser
await fetch('https://api.example.com/auth/login', {
  method: 'POST',
  credentials: 'include', // only needed when the API is on another origin
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password, mode: 'cookie' }),
})

const profile = await fetch('https://api.example.com/profile', { credentials: 'include' })
```

A login without `mode: 'cookie'` gets the tokens in the body, as usual: the same API serves the browser and the mobile application.

## The modes

| Configuration | Cookies | Body |
| --- | --- | --- |
| Body mode (default) | — | `accessToken`, `refreshToken` |
| `cookies: { enabled: true }` | refresh token | `accessToken`, to send in the `Authorization` header |
| `cookies: { enabled: true, accessTokenInCookie: true }` | refresh token, access token | no token |

A token set as a cookie is never returned in the body. Prefer the last mode: with the access token in the body, the page has to keep it in JavaScript.

## Restoring the session

When the page loads, it does not know whether the user is logged in: the cookies are out of its reach. `POST /auth/restore` answers with the user and the expiration of the session, or `401`:

```ts
const res = await fetch('/auth/restore', { method: 'POST', credentials: 'include' })
const session = res.ok ? await res.json() : undefined // { userId, user, expiresIn, expiresAt }
```

Then refresh before `expiresAt` with `POST /auth/refresh`: the cookies are renewed.

## The cookies

| Cookie | Default name | Path | Attributes |
| --- | --- | --- | --- |
| Access token | `__Host-dotpress_access_token` | `/` | `HttpOnly`, `Secure`, `SameSite=Lax` |
| Refresh token | `__Secure-dotpress_refresh_token` | the auth routes (`/auth`) | `HttpOnly`, `Secure`, `SameSite=Strict` |

- **The prefixes** protect the cookies: `__Host-` (secure, path `/`, no `domain`) prevents a subdomain or an insecure page from overwriting the cookie, `__Secure-` prevents an insecure page from overwriting it.
- **The refresh token is only sent to the auth routes**, never to the rest of the API, and never with a navigation from another site (`SameSite=Strict`).
- Its path follows the prefix of the plugin and the [base path](/routing/http-options#base-path) of the app. `cookies.refreshTokenPath` forces another one.
- `secure` is `true` by default. Browsers accept secure cookies on `http://localhost`; set `secure: false` only for another plain HTTP host in development.

## Protection against cross-site request forgery

The browser attaches cookies to every request, including the ones that another site makes it send: that is cross-site request forgery (CSRF). In cookie mode, the plugin checks where the requests authenticated by a cookie come from, with the headers set by the browser (`Sec-Fetch-Site`, then `Origin` for older browsers), as the OWASP recommends. Clients need no CSRF token.

- Requests from the origin of the API are accepted, as well as requests without these headers (clients that are not browsers).
- Requests from another origin, **including another subdomain of the same site**, are accepted only from **trusted origins**.
- Otherwise, the access token cookie is ignored (the request is anonymous, and a warning is logged), and `/auth/refresh` and `/auth/restore` answer `403 CROSS_ORIGIN_REQUEST`.
- `GET`, `HEAD` and `OPTIONS` requests are not checked: they must not change data. Never change data in a `GET` route.
- Requests authenticated by the `Authorization` header are not checked: another site cannot set it.

### Trusted origins

By default, the trusted origins are those of the [`cors` option](/routing/http-options#cors) of the app, when it allows credentials. A front-end on another origin needs this CORS configuration anyway to use the cookies:

```ts
await createApp({
  adapter,
  cors: { origin: ['https://app.example.com'], credentials: true },
  plugins: [authPlugin(auth)],
})
```

`cookies.trustedOrigins` replaces them (`[]` trusts no other origin):

```ts
cookies: { enabled: true, accessTokenInCookie: true, trustedOrigins: ['https://app.example.com'] }
```

For older browsers without `Sec-Fetch-Site`, the `Origin` is compared with the `Host` header: behind a proxy, forward the original `Host`, or list the origin in `trustedOrigins`.

### Routes that read the cookies

A route of your app that reads the auth cookies itself applies the same check with `await auth.isCookieAuthenticationAllowed(ctx.req)`: it returns a promise, so never test it without `await`.

## An application on another site

The defaults suit an application served from the same site as the API (`app.example.com` and `api.example.com`). For an application on another site (`example.app` for `api.example.com`), the cookies need `sameSite: 'none'`: they are then sent with cross-site requests, and the CSRF protection above is what keeps them safe. Prefer serving the application and the API from the same site when you can.

:::tip Coming from v1
The tokens set as cookies are no longer returned in the body, the cookies get the `__Host-` and `__Secure-` prefixes, the refresh token cookie is restricted to the auth routes, and the cookie mode is protected against CSRF. To keep the sessions of your users when upgrading, see [Migrate from v1](/reference/migrate-from-v1).
:::
