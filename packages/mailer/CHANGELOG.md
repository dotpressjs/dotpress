# @dotpress/mailer

## 2.0.0-alpha.6

### Patch Changes

- Updated dependencies [[`eacaf1c`](https://github.com/dotpressjs/dotpress/commit/eacaf1ce2c9168b46c103d89773cade65ed5650e)]:
  - @dotpress/core@2.0.0-alpha.6

## 2.0.0-alpha.5

### Minor Changes

- [#22](https://github.com/dotpressjs/dotpress/pull/22) [`69838d1`](https://github.com/dotpressjs/dotpress/commit/69838d1ac40ee34a16f0883930f03ff291046ab6) Thanks [@renoguyon](https://github.com/renoguyon)! - API review of the mailer and the cache, before the beta. Breaking changes:
  
  - `mailer.withLogger(logger)` and `cache.withLogger(logger)` become `withContext({ logger })`, like the event bus.
  - `MailerLogger` has the methods of the other loggers: `info`, `warn` and `error`, and optionally `debug`. A logger with `info` only is rejected.
  - The attachments given to `send()` and `sendMessage()` are typed `MailAttachmentInput`; providers receive the validated `MailAttachment`.
  - The `Source` type of the mailer is renamed `TemplateSource` (`Source` is a worker source in `@dotpress/events`). `DataOf` and `DataOption` are no longer exported.
  - `createNodemailerProvider(transporter, { name })` takes its name as an option.
  - The `onEvent` option of `createCache()` is renamed `onAccess`, and `CacheEvent` `CacheAccess`.
  - `MemoScope` is exported by `@dotpress/cache` (still by `@dotpress/cache/plugin`): `@dotpress/cache/als` no longer depends on the plugin entry.

### Patch Changes

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
- Updated dependencies [[`7a5edeb`](https://github.com/dotpressjs/dotpress/commit/7a5edeba1d104850a528ffd05909e766332694a4), [`7c669aa`](https://github.com/dotpressjs/dotpress/commit/7c669aa7398a66d01176819417eb41cb38110a48)]:
  - @dotpress/core@2.0.0-alpha.5

## 2.0.0-alpha.4

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.4

## 2.0.0-alpha.3

### Patch Changes

- [#12](https://github.com/dotpressjs/dotpress/pull/12) [`a45d0fd`](https://github.com/dotpressjs/dotpress/commit/a45d0fd5c12d4a6b197ba19bfb8a5c66861ca979) Thanks [@renoguyon](https://github.com/renoguyon)! - Faster attachments: base64 encoding uses `Uint8Array#toBase64` when the runtime has it, and encodes by chunks otherwise. A 20 MB attachment took about a second of CPU, blocking the event loop.

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
