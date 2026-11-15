# Middlewares and filters

A middleware runs before the handler: to authenticate, check a permission, resolve a tenant, rate-limit. A response filter runs after it, to transform the returned value.

## Middlewares

A middleware is a function of the request context. It returns nothing to let the request continue, or an error (or a response) to stop it:

```ts twoslash
import { defineMiddleware, unauthorizedError } from '@dotpress/core'

declare const apiKeys: { isValid(key: string | undefined): Promise<boolean> }
// ---cut---
const requireApiKey = defineMiddleware(async (ctx) => {
  if (!(await apiKeys.isValid(ctx.req.header('x-api-key')))) {
    return unauthorizedError('Invalid API key')
  }
})
```

| A middleware returns | Effect |
| --- | --- |
| nothing | The next middleware runs, then the handler |
| an error (`HttpError`) | The pipeline stops: the error is the response |
| a response helper (`redirect()`, `json()`…) | The pipeline stops: the helper is the response |

Any other value is a bug, answered with a `500`. A thrown error stops the pipeline like a returned one.

`defineMiddleware()` only adds types; a plain function `(ctx) => …` is a middleware too.

## Where to attach them

```ts
// Every route of the app
await createApp({ adapter, middlewares: [requestTimeout] })

// Every route of a group, and of its sub-groups
const admin = createRouteGroup('/admin', [requireAdmin])

// One route
defineRoute({ path: '/reports', middlewares: [requireApiKey], handler })
```

For a request, they run in this order:

1. the global middlewares added by plugins (`@dotpress/auth` reads the token there);
2. the global middlewares of `createApp()`;
3. the middlewares of the groups, outermost first;
4. the middlewares of the route, in order.

Then the request is validated, and the handler runs.

## Middlewares see the raw request

Middlewares run **before** validation (see [Request pipeline](/concepts/request-pipeline#middlewares-run-before-validation)): `ctx.req.params`, `query` and `body` hold the values received, not yet parsed by the schemas. A middleware that reads them checks them itself.

## Middlewares that guarantee a value

A middleware can set a context key and guarantee it to the handlers. Declare the key optional with module augmentation, and the guarantee with the type parameter of `defineMiddleware()`:

```ts twoslash
import { defineMiddleware, forbiddenError } from '@dotpress/core'

interface Workspace {
  id: string
  name: string
}
declare const workspaces: { find(id: string | undefined): Promise<Workspace | undefined> }

declare module '@dotpress/core' {
  interface RequestContext {
    workspace?: Workspace
  }
}
// ---cut---
const requireWorkspace = defineMiddleware<{ workspace: Workspace }>(async (ctx) => {
  ctx.workspace = await workspaces.find(ctx.req.header('x-workspace-id'))
  if (!ctx.workspace) return forbiddenError('Unknown workspace')
})
```

In the routes using `requireWorkspace`, directly or through a group, `ctx.workspace` is a `Workspace`. See [End-to-end typing](/concepts/typing#middlewares-that-guarantee-a-value).

## Documenting the security

A middleware that checks credentials can declare the security scheme it accepts. The [OpenAPI document](/services/openapi) then marks the routes using it as secured:

```ts
const requireApiKey = defineMiddleware(checkApiKey, { security: ['apiKey'] })
```

`requireAuth` and `requireRole()` of `@dotpress/auth` declare `bearerAuth`.

## Native middlewares of your server

Middlewares of the ecosystem of your server (`helmet`, `compression`, a Fastify plugin, a Hono middleware) still work: register them through the `beforeRoutes` option of the adapter. They run before Dotpress, and do not know about the route.

```ts
import helmet from 'helmet'

const app = await createApp({
  adapter: expressAdapter({
    beforeRoutes: (app) => {
      app.use(helmet())
    },
  }),
})
```

Prefer Dotpress middlewares for the logic of your API: they run on every adapter, see the matched route and the typed context, and can be tested in memory. See [Adapters](/adapters/).

## Response filters

A response filter receives the value returned by a handler, and returns the value to send. Use it to wrap every response in an envelope, or to add metadata:

```ts twoslash
import { createRouter } from '@dotpress/core'
// ---cut---
const api = createRouter()

api.addResponseFilter((ctx, result) => ({
  data: result,
  meta: { requestId: ctx.requestId },
}))
```

| Registered with | Applies to |
| --- | --- |
| `createApp({ responseFilters })` | every route of the app |
| `api.addResponseFilter()`, in a plugin | every route of the app, after the filters of `createApp()` |
| `router.addResponseFilter()` | the routes of the router, after the filters above |
| `addResponseFilter()` | the routes of the global router |

Filters can be `async`. They run after the `response` schema has validated the value, and only for JSON results: errors, `text()`, `stream()`, `file()` and the other raw responses are sent as they are.

## Before and after the handler

A middleware only runs before the handler. To measure a request, log it, or run it in a context (tracing, request-scoped storage), write a plugin with the `onResponse` or `wrapRequest` hook. See [Logging and error hooks](./logging).

:::tip Coming from v1
Middlewares now run before validation, and can be attached to groups. Their return value is checked: nothing, an error or a response. The Express hooks `useBeforeRoutes` and `useAfterRoutes` moved to the options of the Express adapter (`beforeRoutes`, `afterRoutes`).
:::
