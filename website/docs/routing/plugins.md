# Plugins

A plugin extends an app with a reusable feature: routes, global middlewares, response filters, context keys and lifecycle hooks. The packages of Dotpress are plugins (`authPlugin()`, `openapiPlugin()`, `mailerPlugin()`…), and your app can have its own.

## Using a plugin

Plugins are given to `createApp()`:

```ts
const app = await createApp({
  adapter,
  plugins: [authPlugin(auth), openapiPlugin({ info: { title: 'My API', version: '1.0.0' } })],
})
```

They are set up in order, after the plugins they depend on.

## Writing a plugin

A plugin is an object declared with `definePlugin()`: a unique `name`, and a `setup()` function that receives the plugin API. A function that takes options and returns the plugin keeps it configurable:

```ts twoslash
import { declareContextKey, definePlugin } from '@dotpress/core'

export interface FeatureFlags {
  isEnabled(flag: string): boolean
  all(): Record<string, boolean>
}

export interface FlagSource {
  forTenant(tenantId: string | undefined): Promise<FeatureFlags>
  close(): Promise<void>
}

// The new context key, typed in every handler of the program.
declare module '@dotpress/core' {
  interface RequestContext {
    flags: Promise<FeatureFlags>
  }
}

// Using ctx.flags without the plugin throws an explicit error, which names
// the function to install: featureFlagsPlugin.
declareContextKey('flags', 'featureFlagsPlugin')

export const featureFlagsPlugin = (source: FlagSource) =>
  definePlugin({
    name: 'featureFlags',
    setup(api) {
      // Computed on first access, once per request.
      api.decorateContext('flags', (ctx) => source.forTenant(ctx.req.header('x-tenant-id')))

      api.addRoute({
        path: '/flags',
        handler: async ({ flags }) => (await flags).all(),
      })

      api.hooks.onClose(() => source.close())
    },
  })
```

Handlers of the app then use `ctx.flags`, typed:

```ts
handler: async ({ flags }) => ((await flags).isEnabled('new-checkout') ? newCheckout() : checkout())
```

## The plugin API

| Method | Description |
| --- | --- |
| `addRoute(route)` | Adds a route, like `defineRoute()` |
| `addRouteGroup(prefix, middlewares)` | Adds a group of routes |
| `addGlobalMiddleware(middleware)` | Runs on every route, before the middlewares of `createApp()` |
| `addResponseFilter(filter)` | Filters every JSON response, after the filters of `createApp()` |
| `decorateContext(key, factory)` | Provides a context key declared by module augmentation, computed on first access |
| `onError(hook)` | Receives the unexpected errors, like the `onError` option of `createApp()` |
| `hooks.onInit`, `onReady`, `onRequest`, `wrapRequest`, `onResponse`, `onClose` | Lifecycle hooks, see below |
| `getRoutes()` | The routes of the app, from `onInit` |
| `getPlugin(name)`, `getPlugins()` | The other plugins |
| `logger` | A logger bound to the plugin |
| `basePath`, `publicBasePath`, `publicPath(path)` | The paths of the app, see [Base path](./http-options#base-path) |
| `cors` | The CORS settings of the app (`credentials`, `isOriginAllowed(req)`) |

Registration methods are only available during `setup()`, which can be `async`: they throw once it has returned.

## Hooks

| Hook | When |
| --- | --- |
| `onInit` | After every plugin is set up and the routes are compiled: inspect the routes |
| `onReady` | After the routes are mounted on the server, before `listen()` |
| `onRequest(ctx)` | For each request matching a route, before the middlewares. Can stop the request, like a middleware. |
| `wrapRequest(ctx, next)` | Runs the pipeline of each request inside a function: tracing, request-scoped storage |
| `onResponse(event)` | For every response, `404` included: logging, metrics. Can replace the response. |
| `onClose` | When `app.close()` is called, after the server has stopped, in reverse order of the plugins: close connections |

See [Logging and error hooks](./logging) for examples.

## Dependencies between plugins

A plugin that needs another one declares it with `dependsOn`: it is set up after it, whatever the order of `plugins`. A missing or circular dependency makes `createApp()` throw.

```ts
definePlugin({
  name: 'auditLog',
  dependsOn: ['auth'], // the name of authPlugin()
  setup(api) {
    // …
  },
})
```

The other properties of a plugin object are visible to other plugins through `api.getPlugin(name)`: a plugin can expose a service to the plugins that depend on it.

## Plugin or middleware?

| Need | Use |
| --- | --- |
| A check on some routes | a middleware on the routes or a group |
| A check on every route | a global middleware of `createApp()` |
| A feature reused across apps, with routes, context keys or hooks | a plugin |
| Services of your app in `ctx` | a small plugin, see [Project structure](/getting-started/project-structure#handlers-find-their-services-in-ctx) |

:::tip Coming from v1
Plugins are objects declared with `definePlugin()`, no longer functions. `addGroup()` is renamed `addRouteGroup()`, and `useBeforeRoutes()` / `useAfterRoutes()` are removed: plugins do not depend on a server, native middlewares go to the adapter options. Plugins gain dependencies, lifecycle hooks and context keys.
:::
