# @dotpress/adapter-express

## 2.0.0-alpha.8

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.8

## 2.0.0-alpha.7

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.7

## 2.0.0-alpha.6

### Patch Changes

- Updated dependencies [[`eacaf1c`](https://github.com/dotpressjs/dotpress/commit/eacaf1ce2c9168b46c103d89773cade65ed5650e)]:
  - @dotpress/core@2.0.0-alpha.6

## 2.0.0-alpha.5

### Minor Changes

- [#18](https://github.com/dotpressjs/dotpress/pull/18) [`ca28c04`](https://github.com/dotpressjs/dotpress/commit/ca28c041d65a4472ed3e579c0a05bf532850040d) Thanks [@renoguyon](https://github.com/renoguyon)! - API review of the adapters, OpenAPI and the test helpers, before the beta. Breaking changes:
  
  - `@dotpress/adapter-hono/lambda` and `@dotpress/adapter-fastify/lambda` export the same types, owned by Dotpress: `LambdaEvent`, `LambdaContext`, `LambdaResult`, `LambdaHandler`, `LambdaHandlerOptions`, `LambdaApp`. The Hono entry no longer re-exports the types of `@hono/aws-lambda` (`APIGatewayProxyResult`).
  - The conformance suite has its own entry, `@dotpress/testing/conformance`: `runConformanceSuite()`, `createHttpTarget()`, `createFetchTarget()`. `ConformanceTarget` is renamed `TestTarget`, exported by both entries.
  - The test targets take `close` as an option, optional: `createHttpTarget(url, { close })`, `createFetchTarget(handle, { close })`, and `createLambdaTarget(handler, { format })` without `close`.
  - `expressAdapter()`, `fastifyAdapter()`, `honoAdapter()`, `createLambdaHandler()`, `openapiPlugin()` (and its `ui`), `generateOpenApi()` and the test targets reject unknown options.
  - `@dotpress/openapi` no longer exports `SCALAR_CDN_URL`. `getDocument()` of the plugin is documented.
  - `@types/express` is an optional peer dependency of `@dotpress/adapter-express`: without it, the Express application is typed `any`.
  
  Fix: the `close()` of the Express adapter closes the responses being streamed when the app serves the Express application with its own server (HTTPS…), like the other adapters.

- [#23](https://github.com/dotpressjs/dotpress/pull/23) [`7a5edeb`](https://github.com/dotpressjs/dotpress/commit/7a5edeba1d104850a528ffd05909e766332694a4) Thanks [@renoguyon](https://github.com/renoguyon)! - Last lot of the API review, before the beta. Breaking changes:
  
  - One verb per operation: `api.addRoute()` becomes `api.defineRoute()`, `api.addRouteGroup()` becomes `api.createGroup()`, and the global `registerResponseFilter()` becomes `addResponseFilter()`, like the methods of routers and plugins.
  - `RouteResponse` becomes `DocumentedResponse`, and `SchemaDefinition`, `SchemaInput` and `SchemaOutput` become `RouteSchemaDefinition`, `RouteSchemaInput` and `RouteSchemaOutput`.
  - `app.listen()` and `HttpAdapter.listen()` return the address of the server, `{ port, host }`: the actual port with `listen(0)`.
  - `redirect(location, { status, headers })` takes an options object, and checks the status.
  - The `origin` function of the `cors` option and `generateRequestId` receive the request of the app (`DotpressRequest`, with `header()`), not the normalized request of the adapter.
  - `RouteMeta.tags` and `security` accept readonly arrays (`as const`).
  - The options of the adapters have a default type parameter (`HonoAdapterOptions` is `HonoAdapterOptions<Hono>`), and the Fastify adapter refuses to listen twice.
  - `@dotpress/testing` exports the types of its signatures: `EnvelopeLike`, `SentMailAddress` and `ExpectedAddresses`.
  
  The error messages of the configuration follow one format, `fn(): message.`, or the subject they are about (`Route "/users": …`).

### Patch Changes

- Updated dependencies [[`7a5edeb`](https://github.com/dotpressjs/dotpress/commit/7a5edeba1d104850a528ffd05909e766332694a4), [`7c669aa`](https://github.com/dotpressjs/dotpress/commit/7c669aa7398a66d01176819417eb41cb38110a48)]:
  - @dotpress/core@2.0.0-alpha.5

## 2.0.0-alpha.4

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.4

## 2.0.0-alpha.3

### Patch Changes

- [#7](https://github.com/dotpressjs/dotpress/pull/7) [`9432ce3`](https://github.com/dotpressjs/dotpress/commit/9432ce318a55287ce2431837075162743dd2389b) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: each package describes itself with an example, and links to its pages on the documentation site, dotpress.dev, which holds the guides and the reference.
- Updated dependencies [[`9432ce3`](https://github.com/dotpressjs/dotpress/commit/9432ce318a55287ce2431837075162743dd2389b)]:
  - @dotpress/core@2.0.0-alpha.3

## 2.0.0-alpha.2

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.2

## 2.0.0-alpha.1

### Patch Changes

- [`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: Dotpress V2 is published as an alpha. Until 2.0.0, install `@dotpress/auth` with the `alpha` tag (`pnpm add @dotpress/auth@alpha`): without it, `@dotpress/auth` is the 1.x.
- Updated dependencies [[`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4)]:
  - @dotpress/core@2.0.0-alpha.1
