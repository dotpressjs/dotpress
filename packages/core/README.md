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
