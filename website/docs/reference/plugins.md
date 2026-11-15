# Plugin API

`definePlugin()`, the API given to `setup()`, and the hooks. For a guide, see [Plugins](/routing/plugins).

```ts twoslash
import { definePlugin } from '@dotpress/core'

interface Metrics {
  observe(name: string, value: number, labels: Record<string, string>): void
}
// ---cut---
export const metricsPlugin = (metrics: Metrics) =>
  definePlugin({
    name: 'metrics',
    setup(api) {
      api.hooks.onResponse(({ route, response, duration }) => {
        metrics.observe('http_request_duration_ms', duration, {
          route: route ? `${route.method.toUpperCase()} ${route.path}` : 'unmatched',
          status: String(response.status),
        })
      })
    },
  })
```

## definePlugin()

```ts
function definePlugin<T extends Plugin>(plugin: T): T

interface Plugin {
  readonly name: string
  readonly dependsOn?: readonly string[]
  setup(api: PluginAPI): void | Promise<void>
}
```

| Member | Description |
| --- | --- |
| `name` | Unique in the app. Used by `dependsOn` and `api.getPlugin()`. |
| `dependsOn` | Names of plugins set up before this one. A missing one makes `createApp()` fail. |
| `setup(api)` | Registers the features of the plugin. Called once, in dependency order. Can be `async`. |

Extra properties are allowed, and readable by other plugins with `api.getPlugin()`. By convention, a plugin is exported as a function that takes its options: `cachePlugin({ cache })`.

The plugins of Dotpress are named `auth`, `cache`, `events`, `mailer` and `openapi`: `dependsOn: ['auth']`.

## PluginAPI

The registration methods work during `setup()` only: called later, they throw.

| Member | Description |
| --- | --- |
| `defineRoute(config)` | Declares a route, like `defineRoute()`. |
| `createGroup(prefix, middlewares?)` | Creates a group, like `createRouteGroup()`. |
| `addGlobalMiddleware(middleware)` | A middleware run on every route, before those of `createApp()`. |
| `addResponseFilter(filter)` | A filter applied to every JSON success, after those of `createApp()`. |
| `decorateContext(key, factory)` | Provides `ctx[key]`: see [Context keys](#context-keys). |
| `onError(hook)` | Called with unexpected errors, like the `onError` option. |
| `hooks` | The [lifecycle and request hooks](#hooks). |
| `name` | The name of the plugin. |
| `logger` | A logger bound to the plugin (`plugin` field). |
| `basePath`, `publicBasePath` | The options of the app, normalized, or `''`. |
| `publicPath(path)` | The path seen by the browser: for a cookie `Path` or a documentation URL. |
| `cors` | The CORS settings: `credentials`, and `isOriginAllowed(req)`. `undefined` without CORS. |
| `getRoutes()` | The mounted routes (`RouteInfo[]`). From the `onInit` hook, or at request time. |
| `getPlugin(name)` | Another plugin, or `undefined`. |
| `getPlugins()` | Every plugin, in setup order. |

## Hooks

| Hook | Signature | When |
| --- | --- | --- |
| `onInit` | `() => void \| Promise<void>` | Every plugin is set up and the routes are compiled. `getRoutes()` is available. |
| `onReady` | `() => void \| Promise<void>` | The routes are mounted on the adapter, before `listen()`. |
| `wrapRequest` | `(ctx, next) => Promise<T>` | Runs the rest of the request inside the hook: must call `next()` and return its result. |
| `onRequest` | `(ctx) => MiddlewareResult` | Each request matching a route, before the middlewares. Returning an error or a response stops it. |
| `onResponse` | `(event) => void \| NormalizedResponse` | Each response, `404`, `405` and adapter errors included. Returning a response replaces it. |
| `onClose` | `() => void \| Promise<void>` | `app.close()`, after the server is stopped. Plugins set up last close first. |

`onInit` and `onReady` run inside `createApp()`: a failure makes it reject. The hooks of several plugins run in setup order; for `wrapRequest`, the first plugin is the outermost.

### The response event

| Field | Description |
| --- | --- |
| `request` | The normalized request. |
| `response` | The normalized response: `status`, `headers`, `body`. |
| `requestId` | The ID of the request. |
| `ctx` | The context, `undefined` when no route matched. |
| `route` | The route (`RouteInfo`), `undefined` when no route matched. |
| `duration` | Time spent producing the response, in milliseconds, without the streamed body. Unlike the options, which take seconds, it is in milliseconds, as most metrics and logs expect. |

### Order in a request

1. CORS preflight requests are answered.
2. No route: `404` or `405`, then `onResponse`.
3. The request ID and the request logger are created.
4. `wrapRequest`, then `onRequest`.
5. The middlewares: plugins, `createApp()`, groups, route.
6. Request validation, the handler, response validation.
7. The response filters: `createApp()`, plugins, router.
8. CORS headers, then `onResponse`.

See [The request pipeline](/concepts/request-pipeline).

## Context keys

```ts
declare module '@dotpress/core' {
  interface RequestContext {
    tenant: TenantService
  }
}

declareContextKey('tenant', 'tenantPlugin')

export const tenantPlugin = (tenants: TenantService) =>
  definePlugin({
    name: 'tenant',
    setup(api) {
      api.decorateContext('tenant', (ctx) => tenants.withLogger(ctx.logger))
    },
  })
```

- **`api.decorateContext(key, factory)`**: the factory receives the context, and runs on first access, at most once per request. Two plugins cannot provide the same key, and the keys of the core (`req`, `res`, `requestId`, `logger`, `raw`, `publicPath`) are reserved.
- **`declareContextKey(key, pluginName)`**: at the top level of the module, next to the augmentation. Without the plugin, `ctx.tenant` throws `"ctx.tenant" is used, but the "tenantPlugin" plugin is not installed in createApp().`

## Plugin or middleware?

A middleware is enough for logic attached to some routes. Write a plugin when the feature needs routes of its own, a context key, a hook on every response, or code at startup and shutdown. See [Plugin or middleware?](/routing/plugins#plugin-or-middleware).
