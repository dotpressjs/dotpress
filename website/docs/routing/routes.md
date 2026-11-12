# Routes

A route is declared with `defineRoute()`: a method, a path and a handler. The value returned by the handler is the response.

```ts twoslash
import { defineRoute } from '@dotpress/core'

declare const articles: {
  list(): Promise<{ id: string; title: string }[]>
  create(input: { title: string }): Promise<{ id: string; title: string }>
}
// ---cut---
defineRoute({
  path: '/articles',
  handler: () => articles.list(),
})

defineRoute({
  method: 'post',
  path: '/articles',
  status: 201,
  schema: (z) => ({ body: z.object({ title: z.string().min(1) }) }),
  handler: ({ req }) => articles.create(req.body),
})
```

## The definition

| Option | Description |
| --- | --- |
| `path` | The path, starting with `/`. Parameters start with `:` (`/articles/:id`). |
| `method` | `get` (default), `post`, `put`, `patch`, `delete`, `head` or `options`. |
| `handler` | Receives the [request context](/concepts/context), returns the response. Can be `async`. |
| `schema` | Zod schemas of the `params`, `query`, `body`, `files` and `response`: see [Validation](./validation). |
| `middlewares` | Middlewares of the route: see [Middlewares](./middlewares). |
| `status` | Success status: `200` by default, `204` when the handler returns nothing. |
| `meta` | Documentation: `summary`, `description`, `tags`, other `responses`, `security`, `hidden`. Used by [OpenAPI](/services/openapi). |
| `bodyLimit` | Maximum body size of this route, in bytes: see [Bodies and file uploads](./bodies). |
| `rawBody` | Keeps the raw bytes of the body in `req.rawBody`, to verify webhook signatures. |

`schema` is a function that receives `z`, so that a route file does not even need to import Zod. A plain object works too: `schema: { body: TaskInput }`.

## Paths

Paths contain static segments and `:param` segments only. Express wildcards, optional parameters and regular expressions are rejected at startup, so that a route behaves the same on every adapter.

The rules of matching are the same on every adapter:

- **Case-sensitive**: `/Articles` does not match `/articles`.
- **Static segments first**: `/articles/latest` wins over `/articles/:id`, whatever the declaration order.
- **Trailing slashes ignored**: `/articles/` matches `/articles`.
- **Parameters are decoded**: `/tags/c%23` gives `req.params.tag === 'c#'`.
- **`HEAD`** uses the `GET` route when there is no `HEAD` route, and never sends a body.

Two routes with the same method and path, parameter names aside, make `createApp()` throw: a route can never shadow another silently.

When the path exists for other methods only, the response is `405 Method Not Allowed`, with an `Allow` header listing them. Otherwise, `404 Not Found`.

## Routers

`defineRoute()` registers the route on the **global router**, which `createApp()` mounts when no `routers` are given. The modules declaring routes must be imported before `createApp()`:

```ts
import './routes/articles.ts'
import './routes/authors.ts'

const app = await createApp({ adapter })
```

For a larger app, create **explicit routers** and give them to the app. Nothing is registered by importing a module, and a test can create an app with only some of the routers:

```ts twoslash
import { createRouter } from '@dotpress/core'
// ---cut---
export const articlesRouter = createRouter()

articlesRouter.defineRoute({
  path: '/articles/:id',
  handler: ({ req }) => ({ id: req.params.id }),
})
```

```ts
const app = await createApp({ adapter, routers: [articlesRouter, authorsRouter] })
```

A router has the methods of a group, `defineRoute()` and `createGroup()`, plus `addResponseFilter()`. See [Project structure](/getting-started/project-structure#explicit-routers).

## Listing the routes

`app.routes` lists the mounted routes, with their method, full path, schemas, metadata and security: useful to check a configuration, or to generate a client.

:::tip Coming from v1
`defineRoute()` keeps the syntax of Dotpress 1. Handlers no longer receive the Express `req` and `res`: they return their value (see [Responses](./responses)), and path parameters are typed from the path, without `params: ['id']`.
:::
