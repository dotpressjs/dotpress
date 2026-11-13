# @dotpress/auth

JWT authentication for [Dotpress](https://dotpress.dev): login, refresh token rotation, `httpOnly` cookie sessions protected against cross-site request forgery, brute force protection, and a typed `ctx.user`. Works with any database through a small data provider, and on any adapter.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0. Until then, install this package with the `alpha` tag: without it, `@dotpress/auth` is the 1.x.

```sh
npm install @dotpress/auth@alpha @dotpress/core zod
```

```ts
import { createApp, defineRoute } from '@dotpress/core'
import { authPlugin, createAuth, requireAuth } from '@dotpress/auth'

declare module '@dotpress/auth' {
  interface AuthUser {
    id: string
    email: string
    roles: string[]
  }
}

const auth = createAuth({
  keys: {
    secretKey: process.env.JWT_PRIVATE_KEY!, // PKCS#8 PEM
    publicKey: process.env.JWT_PUBLIC_KEY!, // SPKI PEM
  },
  issuer: 'https://api.example.com', // checked on every request
  dataProvider, // your users and refresh tokens
  cookies: { enabled: true, accessTokenInCookie: true }, // for browsers
})

defineRoute({
  path: '/profile',
  middlewares: [requireAuth],
  handler: ({ user }) => user, // AuthUser
})

const app = await createApp({ adapter, plugins: [authPlugin(auth)] })
// POST /auth/login, /auth/refresh, /auth/restore, /auth/logout, GET /auth/me
```

## Documentation

- [Authentication](https://dotpress.dev/auth/): the data provider, protecting routes, sessions and tokens, cookie mode and CSRF, clients, passwords and brute force, keys and rotation
- [Security checklist](https://dotpress.dev/auth/security)
- [Auth reference](https://dotpress.dev/reference/auth): every setting, route, error and contract
- [Migrate from v1](https://dotpress.dev/reference/migrate-from-v1#authentication)

## License

MIT
