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

## License

MIT
