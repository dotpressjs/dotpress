# No decorators, no DI

## Context

Frameworks such as NestJS structure an API with classes and decorators: `@Controller()`, `@Get(':id')`, `@Body()`, `@Injectable()`, and a dependency injection container that builds the services. They bring a clear structure, at a cost:

- the types of a request do not come from its validation: a DTO class, decorators for validation, and the handler signature describe the same input three times;
- the behavior depends on metadata and on a container resolved at runtime, hard to follow in the code and to debug;
- legacy decorators and `emitDecoratorMetadata` need a compilation step, and are not supported by tools that only strip types, such as Node.js running TypeScript directly;
- tests go through the container, or rebuild it.

## Decision

- **Routes, middlewares and plugins are plain objects and functions**: `defineRoute({ path, schema, handler })`, `defineMiddleware(fn)`, `definePlugin({ name, setup })`.
- **Types are inferred.** The Zod schemas of a route type its `req.params`, `req.query`, `req.body` and its response; the path types its parameters; a typed middleware types what it guarantees. Nothing is declared twice.
- **No container.** Services are created by your code, and passed explicitly: as arguments of a router factory, or provided in the context by a plugin (`ctx.services`, `ctx.mailer`), typed by module augmentation.
- **No mandatory code generation, no compiler option.**

```ts twoslash
import { createRouter } from '@dotpress/core'

interface TaskService {
  create(input: { title: string }): Promise<{ id: string; title: string }>
}
// ---cut---
export const createTasksRouter = (tasks: TaskService) => {
  const router = createRouter()

  router.defineRoute({
    method: 'post',
    path: '/tasks',
    status: 201,
    schema: (z) => ({ body: z.object({ title: z.string().min(1) }) }),
    handler: ({ req }) => tasks.create(req.body), // req.body: { title: string }
  })

  return router
}
```

## Alternatives considered

- **Decorators and a container**, as in NestJS. Rejected for the reasons above; the structure they bring is kept by conventions: routers per feature, services created at startup.
- **Standard decorators** (TC39, TypeScript 5). They no longer need a compiler option, but do not have parameter decorators nor type metadata: they cannot type a request from its validation.
- **A lightweight container** (tsyringe, Awilix…). Nothing prevents using one with Dotpress; the framework does not need it.

## Consequences

- What a route does is in its definition: no metadata to look up elsewhere.
- The code runs as is with Node.js type stripping: `node src/server.ts`, without a build step.
- Tests create the services they need, real or fake, and pass them: no container to configure.
- Wiring is explicit: in a large app, the composition root (`createApp()` and the factories it calls) grows with the services. It is plain code, readable and refactorable.

See [Typing](/concepts/typing) and [Project structure](/getting-started/project-structure).
