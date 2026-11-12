# Clients

When one API serves several applications, such as a customer app and a backoffice, declare them as clients. Each token then records the application it was issued for, and routes can be restricted to the tokens of one application.

```ts
const auth = createAuth({
  // …
  clients: {
    allowed: ['app', 'backoffice'],
    required: true, // clientId required at login
    isUserRoleAllowed: (role, clientId) => clientId !== 'backoffice' || role === 'admin',
  },
})

createRouteGroup('/backoffice', [requireClient('backoffice'), requireRole('admin')])
```

- The `clientId` of the login must be one of `allowed`: otherwise `400`.
- `isUserRoleAllowed(role, clientId)` decides whether a user may get a token for this client: here, only admins get backoffice tokens.
- The token carries a `client_id` claim, exposed as `ctx.auth.clientId`.
- `requireClient(...clientIds)` answers `403` to the tokens of other clients.
- Removing a client from `allowed` rejects its tokens, and its sessions can no longer be refreshed.

:::warning What a client ID proves
The client ID is declared by the caller: anyone can send `clientId: 'backoffice'`. A `client_id` claim does not prove which application sends a request; it means that the token was issued under the policy of that client (`isUserRoleAllowed`). `requireClient()` keeps the tokens of one application away from the routes of another: combine it with `requireRole()`.
:::

## Session lifetimes per client

Each client can have its own [session lifetimes](./sessions#session-lifetimes):

```ts
const DAY = 24 * 60 * 60

clients: {
  allowed: ['app', 'backoffice'],
  sessions: { backoffice: { idleTimeout: DAY, absoluteTimeout: DAY } },
}
```

Customers stay logged in while they use the app; admins log in every day.

## Without the setting

Without `clients`, the `clientId` sent at login is only reported to the login events (`onLoginSuccess`, `onLoginFailed`), and not written in the token.
