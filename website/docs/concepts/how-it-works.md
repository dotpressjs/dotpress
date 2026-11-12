# How Dotpress works

Dotpress separates what your API does from the server that runs it.

```text
 your code                    @dotpress/core                      adapter
┌──────────────────┐        ┌────────────────────────┐        ┌─────────────────┐
│ routes           │        │ registry of the routes │        │ Express         │
│ groups           │ ─────► │ compiled into a        │ ─────► │ Fastify         │
│ middlewares      │        │ request pipeline       │        │ Hono            │
│ plugins          │        │ (Web standards only)   │        │ AWS Lambda      │
└──────────────────┘        └────────────────────────┘        └─────────────────┘
```

## Routes are declarations

`defineRoute()` does not attach a function to a server: it records a declaration, made of a method, a path, schemas, middlewares and a handler. `createApp()` reads the declarations of its routers, checks them and compiles each route into a request pipeline.

Because the routes are data before they are code:

- **conflicts are detected at startup.** Two routes with the same method and path make `createApp()` throw, instead of one silently shadowing the other;
- **the app can describe itself.** `app.routes` lists the mounted routes, and `@dotpress/openapi` builds the OpenAPI document from the same declarations: the documentation cannot drift from the code;
- **the same routes run anywhere.** Nothing in a route depends on the HTTP server.

## Routers

A router holds route declarations. `createRouter()` creates one, and `createApp({ routers })` mounts them:

```ts
const tasksRouter = createRouter()
tasksRouter.defineRoute({ path: '/tasks', handler: () => [] })

await createApp({ adapter, routers: [tasksRouter] })
```

`defineRoute()` and `createRouteGroup()`, imported on their own, use the global router, which `createApp()` mounts when `routers` is omitted. Both styles are equivalent; explicit routers suit larger apps (see [Project structure](/getting-started/project-structure#explicit-routers)).

## The app

`createApp()` takes an adapter and the rest of the configuration, and returns the app:

```ts
const app = await createApp({
  adapter: expressAdapter(),
  routers: [tasksRouter],
  plugins: [openapiPlugin({ info: { title: 'Tasks API', version: '1.0.0' } })],
})

await app.listen(3000)
// …
await app.close() // waits for pending requests, then closes the plugins
```

Its lifecycle:

1. **`createApp()`** sets up the plugins, in the order of their dependencies, compiles the routes and runs the `onInit` hooks of the plugins.
2. Still in `createApp()`, the adapter mounts the routes on its server, then the `onReady` hooks run.
3. **`app.listen()`** starts the server. On AWS Lambda, the adapter receives the events instead.
4. Each request goes through the [request pipeline](./request-pipeline).
5. **`app.close()`** stops the server, waits for the pending requests, and runs the `onClose` hooks of the plugins, in reverse order.

## Adapters

An adapter connects the core to an HTTP server. On each request, it:

1. converts the native request into a standard one: method, path, headers, cookies, and the body, parsed by Dotpress according to its content type;
2. passes it to the core, which matches the route and runs its pipeline;
3. converts the response back, including streams and Server-Sent Events.

Routing is done by Dotpress, not by the server. The rules are the same everywhere: matching is case-sensitive, static segments win over parameters whatever the declaration order, trailing slashes are ignored, and `HEAD` requests use the `GET` route. Every adapter passes the same conformance test suite.

Your server stays available for what Dotpress does not do: each adapter accepts native middlewares (Express `helmet`, a Fastify plugin…), and `app.native()` returns the server instance. See [Adapters](/adapters/).

## Plugins

A plugin extends the app from the outside: it adds routes, global middlewares, response filters and hooks, and can provide new keys of the request context, such as `ctx.user` for `@dotpress/auth`. The packages of Dotpress are plugins, and your app can have its own. See [Plugins](/routing/plugins).
