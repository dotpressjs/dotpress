# Route groups

A group shares a path prefix and middlewares between routes. It organizes an API by resource (`/projects`), by audience (`/admin`) or by version (`/v2`).

```ts twoslash
import { createRouteGroup, defineMiddleware, forbiddenError } from '@dotpress/core'

declare const isAdmin: (ctx: unknown) => boolean
const requireAdmin = defineMiddleware((ctx) => (isAdmin(ctx) ? undefined : forbiddenError()))
// ---cut---
const admin = createRouteGroup('/admin', [requireAdmin])

admin.defineRoute({
  path: '/users',
  handler: () => [{ id: '1', name: 'Ada' }],
})
```

The route answers `GET /admin/users`, after `requireAdmin`.

## Nested groups

A group creates sub-groups. The prefixes add up, and so do the middlewares, from the outermost group to the route:

```ts twoslash
import { createRouteGroup, defineMiddleware } from '@dotpress/core'

const requireAdmin = defineMiddleware(() => undefined)
const requireBillingAccess = defineMiddleware(() => undefined)
// ---cut---
const admin = createRouteGroup('/admin', [requireAdmin])
const billing = admin.createGroup('/billing', [requireBillingAccess])

billing.defineRoute({
  method: 'post',
  path: '/invoices',
  handler: () => ({ created: true }),
})
```

`POST /admin/billing/invoices` runs `requireAdmin`, then `requireBillingAccess`, then the route middlewares.

## Parameters in the prefix

A prefix can hold parameters. Every route of the group receives them, typed:

```ts twoslash
import { createRouteGroup } from '@dotpress/core'
// ---cut---
const projects = createRouteGroup('/projects/:projectId')
const tasks = projects.createGroup('/tasks')

tasks.defineRoute({
  path: '/:taskId',
  handler: ({ req }) => req.params,
})
```

Hover `req.params`: `{ projectId: string; taskId: string }`. A member check written once on the `/projects/:projectId` group protects every route below it.

## Typed context

A group with a [typed middleware](/concepts/typing#middlewares-that-guarantee-a-value) passes its guarantee to all its routes, sub-groups included. With `requireAuth` on a group, `ctx.user` is defined in every route of the group:

```ts twoslash
import { createRouteGroup } from '@dotpress/core'
import { requireAuth } from '@dotpress/auth'

declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
    name: string
  }
}
// ---cut---
const account = createRouteGroup('/account', [requireAuth])

account.defineRoute({
  path: '/profile',
  handler: ({ user }) => ({ name: user.name }),
})
```

## Groups of a router

`createRouteGroup()` creates a group on the global router. With an [explicit router](./routes#routers), use `router.createGroup()`:

```ts twoslash
import { createRouter } from '@dotpress/core'
// ---cut---
export const projectsRouter = createRouter()
const projects = projectsRouter.createGroup('/projects')

projects.defineRoute({ path: '/', handler: () => [] })
projects.defineRoute({ path: '/:projectId', handler: ({ req }) => req.params })
```

A route at `path: '/'` answers the prefix itself: `GET /projects`. Prefixes start with `/`: to share middlewares without a prefix, give them to each route, or use a [global middleware](./middlewares#where-to-attach-them).

See the [Tasks API example](/examples/tasks-api) for nested groups with access checks.
