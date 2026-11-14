---
'@dotpress/adapter-express': minor
'@dotpress/adapter-fastify': minor
'@dotpress/adapter-hono': minor
'@dotpress/openapi': minor
'@dotpress/testing': minor
---

API review of the adapters, OpenAPI and the test helpers, before the beta. Breaking changes:

- `@dotpress/adapter-hono/lambda` and `@dotpress/adapter-fastify/lambda` export the same types, owned by Dotpress: `LambdaEvent`, `LambdaContext`, `LambdaResult`, `LambdaHandler`, `LambdaHandlerOptions`, `LambdaApp`. The Hono entry no longer re-exports the types of `@hono/aws-lambda` (`APIGatewayProxyResult`).
- The conformance suite has its own entry, `@dotpress/testing/conformance`: `runConformanceSuite()`, `createHttpTarget()`, `createFetchTarget()`. `ConformanceTarget` is renamed `TestTarget`, exported by both entries.
- The test targets take `close` as an option, optional: `createHttpTarget(url, { close })`, `createFetchTarget(handle, { close })`, and `createLambdaTarget(handler, { format })` without `close`.
- `expressAdapter()`, `fastifyAdapter()`, `honoAdapter()`, `createLambdaHandler()`, `openapiPlugin()` (and its `ui`), `generateOpenApi()` and the test targets reject unknown options.
- `@dotpress/openapi` no longer exports `SCALAR_CDN_URL`. `getDocument()` of the plugin is documented.
- `@types/express` is an optional peer dependency of `@dotpress/adapter-express`: without it, the Express application is typed `any`.

Fix: the `close()` of the Express adapter closes the responses being streamed when the app serves the Express application with its own server (HTTPS…), like the other adapters.
