# Project structure

Dotpress does not impose any folder layout. This page recommends one that scales, with its reasons, and when to adopt each step. Start small: a structure only pays off once the app needs it.

## Three steps

| Step | Shape | Example | Move on when… |
| --- | --- | --- | --- |
| 1. One file | Routes and server in `server.ts` | [Express](/examples/express) | the file grows past a hundred lines |
| 2. A few files | `config.ts`, `routes.ts`, `server.ts`, one file per service | [Events](/examples/events), [Cache](/examples/cache), [Mailer](/examples/mailer) | several resources, or a second process (a worker) |
| 3. By feature | `features/` on a shared base | [Tasks API](/examples/tasks-api) | — |

## The structure by feature

Business code is organized **by feature**, on a **shared base** for the infrastructure:

```text
src/
  config.ts                 configuration, validated by Zod at startup
  services/                 creation of the services: functions, not singletons
    index.ts                createRepositories(db), the type of the app services
    bus.ts                  event transport and bus
    mailer.ts               mail provider and mailer
  http/
    server.ts               entry point: config → services → app → listen
    app.ts                  createApp(): plugins and routers
    routes.ts               the routers of the features: the route table
    services-plugin.ts      ctx.services, typed
  worker.ts                 entry point of the event worker
  db/                       connection, schema or migrations
  features/
    tasks/
      routes.ts             the router of the feature, its groups and middlewares
      schemas.ts            Zod schemas shared by several routes
      repository.ts         data access
      events.ts             the events the feature emits
      mails/                the email templates of the feature
    notifications/
      listeners.ts          reactions to the events of other features
test/                       one file per behavior, and a support file
```

The [Tasks API example](/examples/tasks-api) follows this structure.

## The principles

### A feature is a complete folder

The routes, schemas, data access, events and email templates of a feature live together. Adding, changing or removing a feature touches one folder.

The alternative, a folder per technical layer (`handlers/`, `events/`, `mails/`), works with three resources. With twenty, `handlers/` becomes a long flat list, and a single feature such as "assign a task" is spread over four folders.

The shared base (configuration, services, HTTP, database) stays at the root: every feature uses it.

:::tip Domain-driven design
A feature is a vertical slice: it deliberately mixes routes, data access and templates. Teams practicing domain-driven design can map a feature to a bounded context, and split it inside (`domain/`, `application/`, `infrastructure/`).
:::

### Functions that create services, not singletons

`services/` creates the services with functions (`createRepositories(db)`, `createTransport(config)`), called **once per entry point**:

- the API, the worker and the scripts do not need the same services. Each creates its own, and closes them on shutdown;
- each test creates its own services, in memory: no mocks of imported modules, no state leaking from one test to the next;
- nothing connects to a database or a queue when a module is imported.

### Handlers find their services in `ctx`

A small plugin of the app exposes its services in the request context, typed in every handler:

```ts twoslash title="src/http/services-plugin.ts"
import { declareContextKey, definePlugin } from '@dotpress/core'

interface AppServices {
  tasks: { findById(id: string): Promise<{ id: string; title: string } | undefined> }
}

declare module '@dotpress/core' {
  interface RequestContext {
    services: AppServices
  }
}

// Using ctx.services in an app without the plugin throws an explicit error.
declareContextKey('services', 'servicesPlugin')

export const servicesPlugin = (services: AppServices) =>
  definePlugin({
    name: 'services',
    setup(api) {
      api.decorateContext('services', () => services)
    },
  })
```

Route files become plain modules, and the app stays testable: each test creates the app with its own services.

```ts twoslash title="src/features/tasks/routes.ts"
interface AppServices {
  tasks: { findById(id: string): Promise<{ id: string; title: string } | undefined> }
}
declare module '@dotpress/core' {
  interface RequestContext {
    services: AppServices
  }
}
// ---cut---
import { createRouter, notFoundError } from '@dotpress/core'

export const tasksRouter = createRouter()

tasksRouter.defineRoute({
  path: '/tasks/:id',
  handler: async ({ req, services }) =>
    (await services.tasks.findById(req.params.id)) ?? notFoundError('Task not found'),
})
```

It is the mechanism of the Dotpress plugins (`ctx.user`, `ctx.mailer`, `ctx.cache`). Prefer one namespace (`ctx.services.tasks`) to flat keys: `ctx.users`, a repository, would be easy to confuse with `ctx.user`, the authenticated user.

Two things to know about this typing:

- **Module augmentation applies to the whole program**, not to one app: `ctx.services` is typed in every handler of the project. With one app per project, it makes no difference.
- **It exists only if the module that declares it is part of the program.** Import a plugin where you register it, in `http/app.ts`, and its context keys are typed everywhere.

### Explicit routers

`defineRoute()` and `createRouteGroup()` used on their own register the routes on a global router, which `createApp()` mounts by default. It suits a script or a small app, but the routes are registered by importing modules, and every app of the process gets all of them.

As the app grows, each feature exports its own router, and `http/routes.ts` puts them together:

```ts title="src/http/routes.ts"
import { projectsRouter } from '../features/projects/routes.ts'
import { tasksRouter } from '../features/tasks/routes.ts'

export const routers = [projectsRouter, tasksRouter]
```

```ts title="src/http/app.ts"
await createApp({ adapter, routers, plugins: [servicesPlugin(services)] })
```

### Events and listeners

An event belongs to the feature that emits it (`features/tasks/events.ts`); a listener belongs to the feature that reacts (`features/notifications/listeners.ts`). Listeners are created with the services of the process that runs them: the worker in production.

### One entry point per process

Each process has its file, which always does the same: configuration, services, app or worker, start, close on shutdown. In the Tasks API: `http/server.ts`, `worker.ts` and `seed.ts`.

### Tests by behavior

One test file per behavior (a scenario, access rules, the cache…) rather than one per source file, and a `test/support.ts` that creates the app with in-memory services.

## When to split further

- A `routes.ts` of several hundred lines: one file per route or per group in `handlers/`, assembled by `routes.ts`.
- Schemas shared by several routes or by the tests: `schemas.ts`.
- A feature that keeps growing: sub-features (`features/billing/invoices/`), or a domain-driven split inside.
