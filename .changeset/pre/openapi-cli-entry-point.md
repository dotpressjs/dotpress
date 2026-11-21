---
'@dotpress/openapi': minor
'@dotpress/core': minor
'@dotpress/adapter-hono': patch
'@dotpress/adapter-fastify': patch
---

`dotpress-openapi` documents the entry point of the app, with no option: `npx dotpress-openapi src/server.ts`.

- The command imports the module without starting a server: `app.listen()` opens no port, and what the module prints goes to the standard error. It documents the app that the module creates.
- With an AWS Lambda entry point, the factory of `createLambdaHandler()` is called right away.
- An exported function receives an adapter that mounts nothing: factories taking the adapter, like `createTasksApp(adapter)` or `createTasksApp({ adapter })`, work. They failed before, as the function was called without arguments.
- Without `--export`, the command uses the app created by the module, then the `default` export, then the only exported app or function.

`@dotpress/core/adapter` exports `registerLazyApp(factory)`, for handlers that create the app at the first request.
