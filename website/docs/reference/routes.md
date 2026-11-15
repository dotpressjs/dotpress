# Routes and groups

`defineRoute()`, `createRouteGroup()`, `createRouter()` and `defineMiddleware()`. For a guide, see [Routes](/routing/routes), [Route groups](/routing/groups) and [Middlewares](/routing/middlewares).

```ts twoslash
import { createRouter, defineMiddleware, notFoundError } from '@dotpress/core'

interface Tenant {
  id: string
}
declare const tenants: { find(slug: string): Promise<Tenant | undefined> }
declare const projects: {
  find(tenantId: string, id: string): Promise<{ id: string; name: string } | undefined>
}
// ---cut---
const loadTenant = defineMiddleware<{ tenant: Tenant }>(async (ctx) => {
  const tenant = await tenants.find(ctx.req.params.tenant)
  if (!tenant) return notFoundError('Tenant not found')
  Object.assign(ctx, { tenant })
})

export const router = createRouter()
const tenantRoutes = router.createGroup('/tenants/:tenant', [loadTenant])

tenantRoutes.defineRoute({
  path: '/projects/:id',
  schema: (z) => ({ response: z.object({ id: z.string(), name: z.string() }) }),
  meta: { summary: 'Get a project', tags: ['projects'], responses: { 404: 'Not found' } },
  handler: async ({ req, tenant }) =>
    (await projects.find(tenant.id, req.params.id)) ?? notFoundError(),
})
```

## defineRoute()

```ts
function defineRoute(config: RouteConfig): void
```

Declares a route on the global router. `router.defineRoute()` and `group.defineRoute()` take the same configuration.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | required | Starts with `/`. Static segments and `:param` segments only. |
| `method` | `HttpMethod` | `'get'` | `get`, `post`, `put`, `patch`, `delete`, `head` or `options`, in lowercase. `ctx.req.method` is in uppercase, as sent by the client (`'POST'`). |
| `handler` | `(ctx) => result` | required | Receives the [context](./context), returns the response: a value, a [response helper](./responses#response-helpers) or an [`HttpError`](./responses#httperror). Can be `async`. |
| `schema` | `RouteSchema \| (z) => RouteSchema` | — | Zod schemas: see [Schema](#schema). Declare it before `handler`, so the handler is typed from it. |
| `middlewares` | `Middleware[]` | `[]` | Run after the global and group middlewares. |
| `status` | `number` | `200` | Status of a success. `204` when the handler returns `undefined`. |
| `meta` | `RouteMeta` | `{}` | Documentation: see [Metadata](#metadata). |
| `bodyLimit` | `number` | the adapter limit | Maximum body size, in bytes. |
| `rawBody` | `boolean` | `false` | Keeps the raw bytes of the body in `req.rawBody`, typed `Uint8Array`. |

Unknown options are rejected, in `schema` and `meta` too: `middleware` instead of `middlewares` throws a `TypeError`. See [Options and durations](/concepts/options).

### Paths

| Path | `req.params` |
| --- | --- |
| `/articles` | `{}` |
| `/articles/:id` | `{ id: string }` |
| `/orgs/:orgId/members/:id` | `{ orgId: string; id: string }` |

Parameter names match `/^[A-Za-z_][A-Za-z0-9_]*$/`. Wildcards, optional parameters and regular expressions are rejected. Matching is case-sensitive, ignores trailing slashes, and prefers static segments: see [Paths](/routing/routes#paths).

### Schema

```ts
interface RouteSchema {
  params?: Schema
  query?: Schema
  body?: Schema
  files?: Schema
  response?: Schema
}
```

Any Zod 4 schema, classic or mini. The request is validated after the middlewares, and before the handler: `req.params`, `req.query`, `req.body` and `req.files` hold the parsed values, typed by the output of the schemas. An invalid request gets a `400 VALIDATION_FAILED`, with every issue. The response is parsed with `schema.response` (unknown keys of objects are stripped); a value that does not match is a `500`, logged. See [Validation](/routing/validation).

`arrayOf(schema)` validates a field sent once or several times (query string, form fields, files) as an array:

```ts
schema: (z) => ({ query: z.object({ tag: arrayOf(z.string()).default([]) }) })
```

### Metadata

| Field | Type | Description |
| --- | --- | --- |
| `summary`, `description` | `string` | Shown in the documentation. |
| `tags` | `string[]` | Groups the routes in the documentation. |
| `operationId` | `string` | The OpenAPI operation ID. |
| `deprecated` | `boolean` | Marks the route as deprecated. |
| `security` | `string[]` | Security schemes accepted, any of them. Defaults to those of the middlewares; `[]` marks the route as public. |
| `hidden` | `boolean` | Leaves the route out of the documentation. |
| `responses` | `Record<number, string \| { description, schema?, contentType? }>` | Other responses: returned errors, or responses that are not JSON. |

`meta` is used by [`@dotpress/openapi`](/services/openapi), and available to plugins in `app.routes`.

## createRouteGroup()

```ts
function createRouteGroup(prefix: string, middlewares?: Middleware[]): RouteGroup
```

Creates a group on the global router. `router.createGroup()` and `group.createGroup()` take the same arguments.

| Member | Description |
| --- | --- |
| `defineRoute(config)` | Declares a route under the prefix, after the middlewares of the group. |
| `createGroup(prefix, middlewares?)` | A nested group: prefixes and middlewares add up. |
| `prefix` | The prefix of the group. |

Parameters of the prefix (`/tenants/:tenant`) are typed in the routes of the group, and so are the context properties guaranteed by its middlewares. See [Route groups](/routing/groups).

## createRouter()

```ts
function createRouter(): Router
```

An isolated registry of routes, mounted with `createApp({ routers })`.

| Member | Description |
| --- | --- |
| `defineRoute(config)` | Declares a route. |
| `createGroup(prefix, middlewares?)` | Creates a group. |
| `addResponseFilter(filter)` | A filter applied to the JSON results of the routes of this router. |
| `clear()` | Removes every route and filter. |

`globalRouter` is the router of `defineRoute()`, `createRouteGroup()` and `addResponseFilter()`, mounted when `createApp()` has no `routers`.

## defineMiddleware()

```ts
function defineMiddleware<TProvides>(
  middleware: (ctx: RequestContext) => MiddlewareResult | Promise<MiddlewareResult>,
  options?: { security?: string[] }
): Middleware<TProvides>
```

A middleware returns nothing to continue, or an `HttpError` or a response to stop the request. Throwing an `HttpError` works too.

| Parameter | Description |
| --- | --- |
| `TProvides` | The context properties the middleware guarantees: `defineMiddleware<{ tenant: Tenant }>` types `ctx.tenant` as `Tenant` in the handlers of its routes. The middleware must set them, or return an error. |
| `options.security` | Security schemes of the middleware (`['bearerAuth']`): its routes are documented as secured by them. |

A plain function `(ctx) => …` is a middleware too, without guarantees. Middlewares run **before** validation: `ctx.req` holds the raw values. See [Middlewares](/routing/middlewares).

## Response filters

```ts
type ResponseFilter = (ctx: RequestContext, result: unknown) => unknown | Promise<unknown>
```

A filter transforms the JSON result of a success, after the response validation. Filters run in this order: those of `createApp({ responseFilters })`, of the plugins, then of the router (`router.addResponseFilter()`, or `addResponseFilter()` for the global router). Errors and other response helpers do not go through filters. See [Response filters](/routing/middlewares#response-filters).
