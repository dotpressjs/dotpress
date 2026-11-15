---
'@dotpress/core': minor
'@dotpress/adapter-express': minor
'@dotpress/adapter-fastify': minor
'@dotpress/adapter-hono': minor
'@dotpress/testing': minor
'@dotpress/auth': patch
'@dotpress/events': patch
'@dotpress/mailer': patch
'@dotpress/openapi': patch
---

Last lot of the API review, before the beta. Breaking changes:

- One verb per operation: `api.addRoute()` becomes `api.defineRoute()`, `api.addRouteGroup()` becomes `api.createGroup()`, and the global `registerResponseFilter()` becomes `addResponseFilter()`, like the methods of routers and plugins.
- `RouteResponse` becomes `DocumentedResponse`, and `SchemaDefinition`, `SchemaInput` and `SchemaOutput` become `RouteSchemaDefinition`, `RouteSchemaInput` and `RouteSchemaOutput`.
- `app.listen()` and `HttpAdapter.listen()` return the address of the server, `{ port, host }`: the actual port with `listen(0)`.
- `redirect(location, { status, headers })` takes an options object, and checks the status.
- The `origin` function of the `cors` option and `generateRequestId` receive the request of the app (`DotpressRequest`, with `header()`), not the normalized request of the adapter.
- `RouteMeta.tags` and `security` accept readonly arrays (`as const`).
- The options of the adapters have a default type parameter (`HonoAdapterOptions` is `HonoAdapterOptions<Hono>`), and the Fastify adapter refuses to listen twice.
- `@dotpress/testing` exports the types of its signatures: `EnvelopeLike`, `SentMailAddress` and `ExpectedAddresses`.

The error messages of the configuration follow one format, `fn(): message.`, or the subject they are about (`Route "/users": …`).
