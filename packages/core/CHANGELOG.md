# @dotpress/core

## 2.0.0-alpha.8

No changes in this release.

## 2.0.0-alpha.7

No changes in this release.

## 2.0.0-alpha.6

### Minor Changes

- [#25](https://github.com/dotpressjs/dotpress/pull/25) [`eacaf1c`](https://github.com/dotpressjs/dotpress/commit/eacaf1ce2c9168b46c103d89773cade65ed5650e) Thanks [@renoguyon](https://github.com/renoguyon)! - `dotpress-openapi` documents the entry point of the app, with no option: `npx dotpress-openapi src/server.ts`.
  
  - The command imports the module without starting a server: `app.listen()` opens no port, and what the module prints goes to the standard error. It documents the app that the module creates.
  - With an AWS Lambda entry point, the factory of `createLambdaHandler()` is called right away.
  - An exported function receives an adapter that mounts nothing: factories taking the adapter, like `createTasksApp(adapter)` or `createTasksApp({ adapter })`, work. They failed before, as the function was called without arguments.
  - Without `--export`, the command uses the app created by the module, then the `default` export, then the only exported app or function.
  
  `@dotpress/core/adapter` exports `registerLazyApp(factory)`, for handlers that create the app at the first request.

## 2.0.0-alpha.5

### Minor Changes

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

- [#17](https://github.com/dotpressjs/dotpress/pull/17) [`7c669aa`](https://github.com/dotpressjs/dotpress/commit/7c669aa7398a66d01176819417eb41cb38110a48) Thanks [@renoguyon](https://github.com/renoguyon)! - API review of the core, before the beta. Breaking changes:
  
  - `new HttpError(status, code, message, { data, cause })`: the data and the cause are options. The error helpers take the same options: `notFoundError('Task not found', { data: { id } })`, and `errorResponse(status, code, message, options)`. Unknown options throw a `TypeError`.
  - What adapters need moved to `@dotpress/core/adapter`: `CompiledRoute`, `DotpressRuntime`, `createRouteMatcher()`, `parseQueryString()`, `parseRequestBody()`, `DEFAULT_BODY_LIMIT`, `fromWebRequest()`, `readRequestBody()`, `toWebResponse()`, and the body errors (`malformedBodyError()`, `payloadTooLargeError()`, `unsupportedMediaTypeError()`). Helpers used only by the core tests are no longer exported: `fromWebHeaders()`, `parseCookieHeader()`, `serializeCookie()`, `HTTP_METHODS`, `isHttpMethod()`, `isResponseResult()`, `routeNotFoundError()`, `methodNotAllowedError()`.
  - `NormalizedResponse` has no `kind` anymore: adapters read the type of the `body`.
  - `Router` has no `getRoutes()` and `getResponseFilters()` anymore, and `RouteRecord` is no longer exported. `createApp()` only mounts routers made by `createRouter()`.
  - `createApp()`, the routes (with their `schema` and `meta`) and `createConsoleLogger()` reject unknown options, and the logger an unknown `level`.
  - `Duration` and `parseDuration()` are exported by `@dotpress/core`, no longer by `@dotpress/cache`.
  - `RateLimitStore`, `RateLimitState` and `createMemoryRateLimitStore()` are exported by `@dotpress/core`, to be shared by every rate limit: `@dotpress/auth` no longer exports them, nor `memoryRateLimitStore()`.
  
  `createApp()` warns when several copies of `@dotpress/core` are loaded: the routes declared with one copy are not mounted by the other.

## 2.0.0-alpha.4

No changes in this release.

## 2.0.0-alpha.3

### Patch Changes

- [#7](https://github.com/dotpressjs/dotpress/pull/7) [`9432ce3`](https://github.com/dotpressjs/dotpress/commit/9432ce318a55287ce2431837075162743dd2389b) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: each package describes itself with an example, and links to its pages on the documentation site, dotpress.dev, which holds the guides and the reference.

## 2.0.0-alpha.2

No changes in this release.

## 2.0.0-alpha.1

### Patch Changes

- [`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: Dotpress V2 is published as an alpha. Until 2.0.0, install `@dotpress/auth` with the `alpha` tag (`pnpm add @dotpress/auth@alpha`): without it, `@dotpress/auth` is the 1.x.
