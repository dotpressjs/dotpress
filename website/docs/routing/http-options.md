# CORS, cookies and base path

These options of `createApp()` adapt the API to where it runs: browsers on other origins, cookies, a reverse proxy.

## CORS

Browsers block the requests of a page to an API on another origin, unless the API allows them (Cross-Origin Resource Sharing). CORS is **disabled by default**: enable it with the origins you trust.

```ts
const app = await createApp({
  adapter,
  cors: {
    origin: ['https://app.example.com', /^https:\/\/[a-z]+\.example\.com$/],
    credentials: true, // cookies, fetch(…, { credentials: 'include' })
    exposedHeaders: ['x-request-id'],
    maxAge: 600, // preflight cache, in seconds
  },
})
```

| Option | Description |
| --- | --- |
| `origin` | Required. `'*'` (any origin, without credentials), an origin (lowercase, without trailing slash), a regular expression, a list of them, or a function `(origin, request) => boolean`, which can be async. |
| `credentials` | Allows cookies and credentialed requests. Cannot be combined with `'*'`. `false` by default. |
| `allowedHeaders` | Request headers allowed by preflight responses. By default, those the browser asks for. |
| `exposedHeaders` | Response headers the browser may read, besides the safelisted ones. None by default. |
| `maxAge` | How long browsers may cache a preflight response, in seconds. |

- **Preflight requests** from an allowed origin get a `204` listing the methods of the routes of the path, before any middleware: authentication does not block them.
- **Every response** to an allowed origin gets the CORS headers, errors included, so that the client can read a `401` or a `422`.
- **Other origins** get responses without CORS headers: the browser blocks them. CORS is not an access control: the server still answers, and authentication protects the routes.
- `Vary: Origin` is added to every response, unless `origin` is `'*'`, so that caches do not mix origins.

:::warning
List the origins you trust explicitly. A function that accepts any origin, combined with `credentials: true`, lets any website make requests with the cookies of your users.
:::

With `@dotpress/auth` in cookie mode, the origins allowed with credentials are also trusted by its protection against cross-site request forgery (see [Cookie mode and CSRF](/auth/cookies)).

Behind API Gateway or a Lambda Function URL, configure CORS either in AWS or in Dotpress, not both: AWS answers preflight requests before the function runs.

## Cookies

Request cookies are parsed on every request, without a dependency:

```ts
handler: ({ req }) => ({ theme: req.cookies.theme ?? 'light' })
```

Set them with `ctx.res.setCookie(name, value, options)` and remove them with `clearCookie()`. The options are those of the `Set-Cookie` header: `maxAge`, `expires`, `path` (`/` by default), `domain`, `secure`, `httpOnly`, `sameSite`, `partitioned`, `priority`.

No security option is applied for you: set `httpOnly`, `secure` and `sameSite` for every cookie holding a session or a secret. See [Responses](./responses#status-headers-and-cookies).

## Base path

To serve the API under a sub-path, for instance `https://example.com/my-app/api/users` behind a reverse proxy shared by several apps, use one of these options, depending on what the proxy forwards:

```ts
// The proxy forwards the full path (nginx: proxy_pass http://app;)
await createApp({ adapter, basePath: '/my-app/api' })

// The proxy removes the prefix (nginx: proxy_pass http://app/;, Traefik: stripPrefix)
await createApp({ adapter, publicBasePath: '/my-app/api' })
```

- **`basePath`** prefixes every route, plugin routes included: `GET /users` is served at `/my-app/api/users`, and other paths get a `404`. `ctx.req.path` and `app.routes` hold the full paths.
- **`publicBasePath`** does not change the routing. It changes the paths seen by the browser: the paths of the cookies set by plugins, the URLs of the API reference, and the paths built with `publicPath()`.

The two options cannot be combined. `ctx.publicPath()`, `app.publicPath()` and `api.publicPath()` (in plugins) give the browser path of a route path. Redirects are not prefixed automatically, since they may target a page outside of the API:

```ts
defineRoute({
  path: '/old',
  handler: (ctx) => redirect(ctx.publicPath('/new')), // Location: /my-app/api/new
})
```

## Client IP address behind a proxy

`ctx.req.ip` is the address of the client as seen by the HTTP server. Behind a load balancer or a reverse proxy, it is the address of the proxy, unless the server trusts the proxy headers (`X-Forwarded-For`): configure it on the server, for instance the `trust proxy` setting of Express, or the `trustProxy` option of Fastify. Only trust the proxies you run: a client can send any `X-Forwarded-For` header.

The login throttling of `@dotpress/auth` uses this address: see [Passwords and brute force](/auth/passwords).
