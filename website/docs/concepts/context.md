# Request context

Handlers and middlewares receive one argument: the context of the request, `ctx`. Destructure what you need:

```ts twoslash
import { defineRoute } from '@dotpress/core'
// ---cut---
defineRoute({
  path: '/reports/:id',
  handler: ({ req, res, logger, requestId }) => {
    logger.info({ reportId: req.params.id }, 'Report requested')
    res.setHeader('cache-control', 'no-store')
    return { id: req.params.id, requestId }
  },
})
```

## What it holds

| Key | Content |
| --- | --- |
| `req` | The request: `method`, `path`, `url`, typed `params`, `query`, `body` and `files`, `headers` (lowercase names), `cookies`, `ip`, `signal`, `header(name)` |
| `res` | Response metadata: `setStatus()`, `setHeader()`, `appendHeader()`, `removeHeader()`, `setCookie()`, `clearCookie()` |
| `requestId` | The ID of the request, also sent in the `X-Request-ID` header |
| `logger` | A logger bound to the request: every line carries the request ID |
| `raw` | The native request of the adapter (Express, Fastify, Hono, Lambda event), as an escape hatch |
| `publicPath(path)` | The path of a route as seen by the browser, behind a proxy (see [base path](/routing/http-options)) |

`req` and `res` are the same on every adapter: a handler never touches the native request or response. It returns its value, and sets the status, headers and cookies on `res`.

`req.signal` is aborted when the client disconnects: pass it to long operations (`fetch(url, { signal: req.signal })`).

## Keys added by plugins

Plugins add their own keys to the context, typed:

| Key | Plugin |
| --- | --- |
| `ctx.user`, `ctx.auth` | `@dotpress/auth`: the authenticated user and their token |
| `ctx.memo`, `ctx.cache` | `@dotpress/cache` |
| `ctx.events` | `@dotpress/events` |
| `ctx.mailer` | `@dotpress/mailer` |

Keys provided with `decorateContext()` are computed on first access, at most once per request: a route that does not use the mailer does not pay for it.

Using the key of a plugin that is not installed throws an explicit error, rather than returning `undefined`:

```text
"ctx.mailer" is used, but the "mailerPlugin" plugin is not installed in createApp().
```

## Adding your own keys

The context is extended with TypeScript module augmentation. A plugin provides the value, as in this plugin that exposes the services of the app:

```ts twoslash
import { declareContextKey, definePlugin } from '@dotpress/core'

interface AppServices {
  tasks: { findById(id: string): Promise<{ id: string } | undefined> }
}

declare module '@dotpress/core' {
  interface RequestContext {
    services: AppServices
  }
}

declareContextKey('services', 'servicesPlugin')

export const servicesPlugin = (services: AppServices) =>
  definePlugin({
    name: 'services',
    setup(api) {
      api.decorateContext('services', () => services)
    },
  })
```

A middleware can also set a key for the request, such as the tenant of a multi-tenant API. Declare it optional, and let a [typed middleware](./typing#middlewares-that-guarantee-a-value) guarantee it to the handlers.

See [Project structure](/getting-started/project-structure#handlers-find-their-services-in-ctx) for the pattern in a complete app.
