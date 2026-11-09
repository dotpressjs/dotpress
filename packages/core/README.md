# @dotpress/core

Lightweight, decorator-free TypeScript framework for end-to-end typed HTTP APIs.

The core is independent of the HTTP server: it compiles your routes into a request pipeline that an adapter (Express, Hono, Fastify…) mounts on its server. It only relies on Web-standard APIs.

> 🚧 Dotpress V2 is under active development and not published yet.

```ts
import { createApp, defineRoute, notFoundError, sse } from '@dotpress/core'

defineRoute({
  method: 'post',
  path: '/orgs/:orgId/members',
  status: 201,
  schema: (z) => ({
    body: z.object({ name: z.string(), age: z.number().min(13) }),
    response: z.object({ id: z.string() }),
  }),
  handler: async ({ req }) => {
    // req.params: { orgId: string }, req.body: { name: string; age: number }
    if (req.body.name === 'unknown') return notFoundError()
    return { id: '...' }
  },
})

defineRoute({
  path: '/orders/live',
  // Server-Sent Events, stopped when the client disconnects
  handler: () =>
    sse(async function* ({ signal }) {
      for await (const order of watchOrders({ signal })) {
        yield { event: 'order', id: order.id, data: order }
      }
    }),
})

const app = await createApp({ adapter: /* an HTTP adapter */ })
await app.listen(3000)
```

## Repeated fields

A query parameter, form field or file sent once gives a single value; sent several times, an array. `arrayOf()` always gives an array:

```ts
import { arrayOf } from '@dotpress/core'

schema: (z) => ({
  query: z.object({ tag: arrayOf(z.string()).default([]) }),
  files: z.object({ photos: arrayOf(z.array(z.file()).max(5)) }),
})
```

## Route documentation

Routes describe themselves for documentation generators (`@dotpress/openapi`): schemas, success `status`, and `meta`:

```ts
defineRoute({
  path: '/members/:id',
  middlewares: [requireAuth],
  schema: (z) => ({ response: Member }),
  meta: {
    summary: 'Get a member',
    tags: ['members'],
    responses: { 404: 'Member not found' }, // other responses, by status
  },
  handler: ...,
})
```

- **Security** comes from the middlewares: a middleware declared with `defineMiddleware(fn, { security: ['bearerAuth'] })` marks the routes using it, directly or through a group, as secured. `meta.security` overrides it (`[]` for a public route). `app.routes[i].security` holds the result.
- **`meta.responses`** documents the other responses of a route: errors returned by the handler, or bodies that are not JSON (`{ description: 'CSV export', contentType: 'text/csv' }`). An entry is a description, or an object with a `description`, an optional `schema` and an optional `contentType`.
- **`meta.hidden`** excludes a route from the documentation.

## CORS

Cross-origin requests from browsers (CORS) are disabled by default. Enable them with the list of allowed origins:

```ts
await createApp({
  adapter,
  cors: {
    origin: ['https://app.example.com', /^https:\/\/[a-z]+\.example\.com$/],
    credentials: true, // cookies, fetch(..., { credentials: 'include' })
    exposedHeaders: ['x-request-id'],
    maxAge: 600, // preflight cache, in seconds
  },
})
```

| Option | Description |
| --- | --- |
| `origin` | Required. `'*'` (any origin, without credentials), an origin (`'https://app.example.com'`, lowercase, without trailing slash), a regular expression, a list of origins and regular expressions, or a function `(origin, request) => boolean \| Promise<boolean>`. A failing function is logged and refuses the origin. |
| `credentials` | Allows cookies and credentialed requests. Cannot be combined with `'*'`. Defaults to `false`. |
| `allowedHeaders` | Request headers allowed by preflight responses. Defaults to the headers requested by the browser. |
| `exposedHeaders` | Response headers readable by the browser, besides the CORS-safelisted ones. Defaults to none. |
| `maxAge` | How long browsers may cache preflight responses, in seconds. |

- **Preflight requests** (`OPTIONS` with `Origin` and `Access-Control-Request-Method`) from an allowed origin get a `204` response listing the methods of the routes of the path, before the middlewares (authentication) and explicit `OPTIONS` routes. From other origins or for unknown paths, they are handled as usual (`405`, `404`).
- **Every response** of Dotpress to an allowed origin gets the CORS headers, errors included (`401`, `404`, `422`, `500`…), so that the browser can read them. Responses to other origins are sent without CORS headers: the browser blocks them. The server does not reject them, protection against cross-site requests is the job of authentication (see the cookie mode of `@dotpress/auth`).
- `Vary: Origin` is added to every response, unless `origin` is `'*'`, so that HTTP caches do not mix up origins.
- The CORS headers are set before the `onResponse` hooks, which see the final response.
- Plugins read the settings with `api.cors` (`credentials`, and `isOriginAllowed(req)`): `@dotpress/auth` trusts the allowed origins for its protection against cross-site request forgery when `credentials` is `true`.
- Native routes of the HTTP server (Express, Fastify) are not covered. Behind API Gateway or a Lambda Function URL, configure CORS either in AWS or in Dotpress, not both: AWS answers preflight requests before the function.

## Base path

To serve the app under a sub-path, for instance `https://example.com/my-app/api/users` behind a reverse proxy shared by several apps, use one of these options, depending on what the proxy forwards:

```ts
// The proxy forwards the full path (nginx: proxy_pass http://app;)
await createApp({ adapter, basePath: '/my-app/api' })

// The proxy removes the prefix (nginx: proxy_pass http://app/;, Traefik: stripPrefix)
await createApp({ adapter, publicBasePath: '/my-app/api' })
```

- **`basePath`** prefixes every route, including plugin routes: `GET /users` is served at `/my-app/api/users`, and requests outside of the base path get a `404`. `ctx.req.path` and `app.routes` hold the full paths.
- **`publicBasePath`** does not change the routing. It only changes the paths seen by the browser: cookie paths set by plugins, documentation URLs, and the paths built with `publicPath()`.

The two options cannot be combined. `ctx.publicPath()`, `app.publicPath()` and `api.publicPath()` (in plugins) give the browser path of a route path. Redirects are not prefixed automatically, since they may target a page outside of the API:

```ts
defineRoute({
  path: '/old',
  handler: (ctx) => redirect(ctx.publicPath('/new')), // Location: /my-app/api/new
})
```

## License

MIT
