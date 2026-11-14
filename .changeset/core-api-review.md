---
'@dotpress/core': minor
'@dotpress/auth': minor
'@dotpress/cache': minor
---

API review of the core, before the beta. Breaking changes:

- `new HttpError(status, code, message, { data, cause })`: the data and the cause are options. The error helpers take the same options: `notFoundError('Task not found', { data: { id } })`, and `errorResponse(status, code, message, options)`. Unknown options throw a `TypeError`.
- What adapters need moved to `@dotpress/core/adapter`: `CompiledRoute`, `DotpressRuntime`, `createRouteMatcher()`, `parseQueryString()`, `parseRequestBody()`, `DEFAULT_BODY_LIMIT`, `fromWebRequest()`, `readRequestBody()`, `toWebResponse()`, and the body errors (`malformedBodyError()`, `payloadTooLargeError()`, `unsupportedMediaTypeError()`). Helpers used only by the core tests are no longer exported: `fromWebHeaders()`, `parseCookieHeader()`, `serializeCookie()`, `HTTP_METHODS`, `isHttpMethod()`, `isResponseResult()`, `routeNotFoundError()`, `methodNotAllowedError()`.
- `NormalizedResponse` has no `kind` anymore: adapters read the type of the `body`.
- `Router` has no `getRoutes()` and `getResponseFilters()` anymore, and `RouteRecord` is no longer exported. `createApp()` only mounts routers made by `createRouter()`.
- `createApp()`, the routes (with their `schema` and `meta`) and `createConsoleLogger()` reject unknown options, and the logger an unknown `level`.
- `Duration` and `parseDuration()` are exported by `@dotpress/core`, no longer by `@dotpress/cache`.
- `RateLimitStore`, `RateLimitState` and `createMemoryRateLimitStore()` are exported by `@dotpress/core`, to be shared by every rate limit: `@dotpress/auth` no longer exports them, nor `memoryRateLimitStore()`.

`createApp()` warns when several copies of `@dotpress/core` are loaded: the routes declared with one copy are not mounted by the other.
