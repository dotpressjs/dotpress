# A declarative registry

## Context

In most HTTP frameworks, declaring a route registers a function on a server at once: `app.get('/tasks/:id', handler)`. The route only exists inside the server, in the order it was registered. Nothing can list the routes, check them against each other, or describe them, without running requests.

An API needs exactly that: its documentation, its client, its tests and its security review all start from the list of its routes, with their inputs and outputs.

## Decision

- **A route is a declaration**: a method, a path, schemas, middlewares, metadata and a handler, recorded by a router. Declaring it runs nothing.
- **`createApp()` compiles the declarations** of its routers, checks them, and builds a request pipeline per route, before mounting them on the adapter.
- **Routers are instances.** `createRouter()` creates an isolated registry, mounted with `createApp({ routers })`.
- **A global router**, for small apps: `defineRoute()` and `createRouteGroup()` register on it, and `createApp()` mounts it when no `routers` are given.

## Alternatives considered

- **Registering routes on the server directly.** The simplest, but it ties the routes to one server, and leaves nothing to inspect.
- **A global registry only.** Convenient, but routes depend on which modules happen to be imported, two apps in a process share them, and tests are not isolated.
- **File-system routing**, a file per route. Popular in full-stack frameworks, but it needs a build step or a loader, and the path of a route moves away from its code.

## Consequences

- **Conflicts are detected at startup**: two routes with the same method and path make `createApp()` throw, instead of one shadowing the other.
- **The app describes itself**: `app.routes` lists the mounted routes with their schemas, metadata and security, and `@dotpress/openapi` builds the OpenAPI document from them. The documentation cannot drift from the code.
- **Matching is the same on every adapter**: Dotpress matches the routes itself, with the same rules everywhere.
- **Tests choose their routes**: an app made of one router tests it in isolation, and several apps can live in one process.
- **Plugins add routes like an app does**: `api.defineRoute()` records declarations, checked with the others.
- With the global router, the modules that declare routes must be imported before `createApp()`. Explicit routers avoid this.

See [How Dotpress works](/concepts/how-it-works) and [Routers](/routing/routes#routers).
