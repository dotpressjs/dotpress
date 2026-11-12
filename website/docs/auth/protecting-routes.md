# Protecting routes

The auth plugin reads the access token of every request. When it is valid, `ctx.user` and `ctx.auth` are set; otherwise, the request stays anonymous. Guards then decide which routes need a user.

## Guards

```ts twoslash
import { createRouteGroup, defineRoute } from '@dotpress/core'
import { requireAuth, requireRole } from '@dotpress/auth'

declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
    email: string
    roles: string[]
  }
}
// ---cut---
// One route
defineRoute({
  path: '/profile',
  middlewares: [requireAuth],
  handler: ({ user }) => ({ email: user.email }),
})

// Every route of a group
const admin = createRouteGroup('/admin', [requireRole('admin')])

admin.defineRoute({
  path: '/stats',
  handler: ({ user, auth }) => ({ admin: user.id, roles: auth.roles }),
})
```

| Guard | Without user | Without the right |
| --- | --- | --- |
| `requireAuth` | `401` | — |
| `requireRole(...roles)` | `401` | `403` without one of the roles |
| `requireClient(...clientIds)` | `401` | `403` when the token was issued for another client, see [Clients](./clients) |

A `401` carries a `WWW-Authenticate: Bearer` header (RFC 6750), with `error="invalid_token"` when the request sent an expired, revoked or invalid token: the client knows it must refresh.

Guards are [typed middlewares](/concepts/typing#middlewares-that-guarantee-a-value): in the routes using them, directly or through a group, `ctx.user` and `ctx.auth` are defined. They also declare the `bearerAuth` security scheme: the [OpenAPI document](/services/openapi) marks these routes as secured, and the API reference shows an Authorize button.

## The type of the user

`ctx.user` is what `dataProvider.findUserById()` returns. Describe it once:

```ts
declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
    email: string
    roles: string[]
  }
}
```

`ctx.auth` holds the access token data:

| Field | Content |
| --- | --- |
| `userId` | The `sub` claim |
| `sessionId` | The session (`sid` claim): see [Sessions and tokens](./sessions) |
| `clientId` | The client application, with the `clients` setting |
| `roles` | The roles of the user |
| `tokenId` | The `jti` claim |
| `username` | Only with the `usernameClaim` setting |
| `claims` | Every claim of the token |

## Roles

`requireRole()` checks the `roles` array of the user, or its `role` string. When roles are stored elsewhere, `getUserRoles(user)` returns them:

```ts
createAuth({
  // …
  getUserRoles: (user) => user.memberships.map((membership) => membership.role),
})
```

## Routes for everyone, better for users

Without a guard, a route serves anonymous and authenticated users alike: `ctx.user` is then `AuthUser | undefined`.

```ts
defineRoute({
  path: '/articles/:id',
  handler: async ({ req, user }) => {
    const article = await articles.find(req.params.id)
    return { ...article, bookmarked: user ? await bookmarks.has(user.id, article.id) : false }
  },
})
```

## Authentication is not authorization

`requireAuth` proves who the user is, not what they may access. A route that reads `/invoices/:id` must still check that this invoice belongs to the user: otherwise, any user can read any invoice by changing the ID in the URL. It is the most common vulnerability of APIs ([OWASP API1: Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/)).

```ts twoslash
import { createRouteGroup, notFoundError } from '@dotpress/core'
import { requireAuth } from '@dotpress/auth'

declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
  }
}
declare const invoices: {
  find(id: string): Promise<{ id: string; customerId: string; total: number } | undefined>
}
// ---cut---
const myInvoices = createRouteGroup('/invoices', [requireAuth])

myInvoices.defineRoute({
  path: '/:id',
  handler: async ({ req, user }) => {
    const invoice = await invoices.find(req.params.id)
    // Not found, rather than forbidden: do not reveal that the invoice exists.
    if (!invoice || invoice.customerId !== user.id) return notFoundError('Invoice not found')
    return invoice
  },
})
```

Check access in the query itself when you can (`WHERE id = ? AND customer_id = ?`), or in a middleware of the group for a whole resource: the [Tasks API example](/examples/tasks-api) checks the membership of a project once, on the `/projects/:projectId` group.

## Reading the cookies yourself

In cookie mode, a route of the app that reads the auth cookies itself must apply the same protection against cross-site requests as the plugin: `auth.isCookieAuthenticationAllowed(ctx.req)`. See [Cookie mode and CSRF](./cookies).
