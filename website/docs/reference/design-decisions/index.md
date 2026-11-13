# Design decisions

These pages record the choices that shape Dotpress, and why they were made: the context, the decision, the alternatives that were set aside, and the consequences, good and bad. They explain why the API looks the way it does, and what to expect from it.

| Decision | In short |
| --- | --- |
| [Errors are returned](./returned-errors) | A handler returns its errors like any other value. Throwing works too, with the same response. |
| [A declarative registry](./declarative-registry) | Routes are declarations, compiled at startup: conflicts are detected, and the app describes itself. |
| [No decorators, no DI](./no-decorators) | Plain functions and objects, typed by inference. Services are passed explicitly, or provided by plugins. |
| [A transport-agnostic core](./agnostic-core) | The core knows nothing of the HTTP server: adapters translate, on Web standards. |
| [No edge runtime in 2.0](./edge) | 2.0 supports Node.js and AWS Lambda. The core stays portable, so that edge runtimes can come later. |

They share a few principles:

1. **The core depends on no HTTP server.** No Express, Fastify or Hono in `@dotpress/core`.
2. **Plugins do not know their adapter.** A plugin that needs a specific server is a design smell.
3. **Services work on their own.** The mailer, the event bus and the cache run in a script or a worker, without an app.
4. **Types are inferred, not declared.** You write schemas; the types follow.
5. **Sensible defaults, everything configurable.**
