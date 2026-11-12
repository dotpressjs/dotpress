# End-to-end typing

In Dotpress, you write types once, as schemas and paths, and TypeScript infers the rest. No generic to pass to `defineRoute()`, no interface to keep in sync with a validator.

Every snippet of this page is compiled against Dotpress when the site is built: hover the code to see what your editor sees.

## Path parameters come from the path

```ts twoslash
import { createRouteGroup } from '@dotpress/core'
// ---cut---
const projects = createRouteGroup('/orgs/:orgId/projects')

projects.defineRoute({
  path: '/:projectId/tasks/:taskId',
  handler: ({ req }) => req.params,
})
```

`req.params` is `{ orgId: string; projectId: string; taskId: string }`: the prefixes of the groups count, nested groups included. A typo such as `req.params.projectID` is a compile error.

Give a `params` schema to validate or convert them: `params: z.object({ taskId: z.uuid() })`.

## Schemas type the request

The handler receives the values parsed by the schemas: coerced, trimmed, with their defaults.

```ts twoslash
import { defineRoute } from '@dotpress/core'
// ---cut---
defineRoute({
  path: '/tasks',
  schema: (z) => ({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      done: z.stringbool().optional(),
      sort: z.enum(['date', 'title']).default('date'),
    }),
  }),
  handler: ({ req }) => {
    const { page, done, sort } = req.query
    return { page, done, sort }
  },
})
```

A query string only carries strings: `z.coerce.number()` turns `?page=2` into `2`, and `z.stringbool()` turns `?done=true` into `true`. The same applies to `body` and to uploaded `files`.

## The response is checked

With a `response` schema, the value returned by the handler must match it. A missing field is a compile error, before any test runs:

```ts twoslash
// @errors: 2322
import { defineRoute } from '@dotpress/core'
// ---cut---
defineRoute({
  path: '/me',
  schema: (z) => ({
    response: z.object({ id: z.string(), email: z.email() }),
  }),
  handler: () => ({ id: 'u_1' }),
})
```

At runtime, the response schema also validates and strips the value: a field that is not in the schema, such as a password hash, never reaches the client.

Errors stay allowed: a handler with a `response` schema can still return `notFoundError()`.

## Middlewares that guarantee a value

A middleware declared with `defineMiddleware<{ … }>()` tells TypeScript what it guarantees to the handlers that use it, directly or through a group.

```ts twoslash
import { createRouteGroup, defineMiddleware, forbiddenError } from '@dotpress/core'

interface Tenant {
  id: string
  plan: 'free' | 'pro'
}
declare const tenants: { byHost(host: string | undefined): Promise<Tenant | undefined> }

declare module '@dotpress/core' {
  interface RequestContext {
    tenant?: Tenant
  }
}

const requireTenant = defineMiddleware<{ tenant: Tenant }>(async (ctx) => {
  ctx.tenant = await tenants.byHost(ctx.req.header('host'))
  if (!ctx.tenant) return forbiddenError('Unknown tenant')
})

const settings = createRouteGroup('/settings', [requireTenant])

settings.defineRoute({
  path: '/',
  handler: ({ tenant }) => ({ plan: tenant.plan }),
})
```

In the routes of the group, `tenant` is a `Tenant`, not `Tenant | undefined`: no non-null assertion, no repeated check. Elsewhere, it stays optional.

## The authenticated user

`@dotpress/auth` works the same way. Describe your user once, and `requireAuth` guarantees it:

```ts twoslash
import { defineRoute } from '@dotpress/core'
import { requireAuth } from '@dotpress/auth'

declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
    email: string
    roles: string[]
  }
}

defineRoute({
  path: '/profile',
  middlewares: [requireAuth],
  handler: ({ user }) => ({ email: user.email }),
})
```

See [Protecting routes](/auth/protecting-routes).

## Context keys and services

The keys added by plugins (`ctx.mailer`, `ctx.events`, `ctx.cache`) and by your app (`ctx.services`) are typed in every handler: your editor completes their methods and checks their arguments. A mail template, for instance, checks the data it receives. See [Request context](./context).

## Where types stop

Types describe what your code does; schemas check what clients send. Dotpress uses both:

- **at compile time**, TypeScript checks your handlers against the types inferred from the schemas;
- **at runtime**, the schemas validate every request, and the response when there is a `response` schema.

A client can send anything: only the schemas protect the handler from it. Declare a schema for every input your handler reads.
