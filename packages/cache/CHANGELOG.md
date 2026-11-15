# @dotpress/cache

## 2.0.0-alpha.5

### Minor Changes

- [#17](https://github.com/dotpressjs/dotpress/pull/17) [`7c669aa`](https://github.com/dotpressjs/dotpress/commit/7c669aa7398a66d01176819417eb41cb38110a48) Thanks [@renoguyon](https://github.com/renoguyon)! - API review of the core, before the beta. Breaking changes:
  
  - `new HttpError(status, code, message, { data, cause })`: the data and the cause are options. The error helpers take the same options: `notFoundError('Task not found', { data: { id } })`, and `errorResponse(status, code, message, options)`. Unknown options throw a `TypeError`.
  - What adapters need moved to `@dotpress/core/adapter`: `CompiledRoute`, `DotpressRuntime`, `createRouteMatcher()`, `parseQueryString()`, `parseRequestBody()`, `DEFAULT_BODY_LIMIT`, `fromWebRequest()`, `readRequestBody()`, `toWebResponse()`, and the body errors (`malformedBodyError()`, `payloadTooLargeError()`, `unsupportedMediaTypeError()`). Helpers used only by the core tests are no longer exported: `fromWebHeaders()`, `parseCookieHeader()`, `serializeCookie()`, `HTTP_METHODS`, `isHttpMethod()`, `isResponseResult()`, `routeNotFoundError()`, `methodNotAllowedError()`.
  - `NormalizedResponse` has no `kind` anymore: adapters read the type of the `body`.
  - `Router` has no `getRoutes()` and `getResponseFilters()` anymore, and `RouteRecord` is no longer exported. `createApp()` only mounts routers made by `createRouter()`.
  - `createApp()`, the routes (with their `schema` and `meta`) and `createConsoleLogger()` reject unknown options, and the logger an unknown `level`.
  - `Duration` and `parseDuration()` are exported by `@dotpress/core`, no longer by `@dotpress/cache`.
  - `RateLimitStore`, `RateLimitState` and `createMemoryRateLimitStore()` are exported by `@dotpress/core`, to be shared by every rate limit: `@dotpress/auth` no longer exports them, nor `memoryRateLimitStore()`.
  
  `createApp()` warns when several copies of `@dotpress/core` are loaded: the routes declared with one copy are not mounted by the other.

- [#22](https://github.com/dotpressjs/dotpress/pull/22) [`69838d1`](https://github.com/dotpressjs/dotpress/commit/69838d1ac40ee34a16f0883930f03ff291046ab6) Thanks [@renoguyon](https://github.com/renoguyon)! - API review of the mailer and the cache, before the beta. Breaking changes:
  
  - `mailer.withLogger(logger)` and `cache.withLogger(logger)` become `withContext({ logger })`, like the event bus.
  - `MailerLogger` has the methods of the other loggers: `info`, `warn` and `error`, and optionally `debug`. A logger with `info` only is rejected.
  - The attachments given to `send()` and `sendMessage()` are typed `MailAttachmentInput`; providers receive the validated `MailAttachment`.
  - The `Source` type of the mailer is renamed `TemplateSource` (`Source` is a worker source in `@dotpress/events`). `DataOf` and `DataOption` are no longer exported.
  - `createNodemailerProvider(transporter, { name })` takes its name as an option.
  - The `onEvent` option of `createCache()` is renamed `onAccess`, and `CacheEvent` `CacheAccess`.
  - `MemoScope` is exported by `@dotpress/cache` (still by `@dotpress/cache/plugin`): `@dotpress/cache/als` no longer depends on the plugin entry.

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

- [#4](https://github.com/dotpressjs/dotpress/pull/4) [`ad895a0`](https://github.com/dotpressjs/dotpress/commit/ad895a09a51f23bf659dc497e15768e7673b17f3) Thanks [@renoguyon](https://github.com/renoguyon)! - `cache.getOrSet()`: with an entry typed by its `schema` (or explicit types), the loader may return `undefined` (not found), as the cache already accepted it at runtime: the value is not cached, and the result is typed `T | undefined`. A loader returning a value keeps the result typed `T`.
- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.2

## 2.0.0-alpha.1

### Patch Changes

- [`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: Dotpress V2 is published as an alpha. Until 2.0.0, install `@dotpress/auth` with the `alpha` tag (`pnpm add @dotpress/auth@alpha`): without it, `@dotpress/auth` is the 1.x.
- Updated dependencies [[`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4)]:
  - @dotpress/core@2.0.0-alpha.1
