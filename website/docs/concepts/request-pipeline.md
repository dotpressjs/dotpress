# Request pipeline

Every request goes through the same steps, in the same order, on every adapter.

```text
request
  │
  ├─ adapter: parse the request (headers, cookies, body by content type)
  ├─ CORS preflight? ──────────────────────────────► 204
  ├─ no matching route ────────────────────────────► 404, or 405 with Allow
  │
  ├─ request ID and request logger
  ├─ onRequest hooks (plugins)
  ├─ global middlewares (plugins first, then createApp)
  ├─ group middlewares, outermost group first
  ├─ route middlewares
  ├─ request validation: params, query, body, files ► 400 VALIDATION_FAILED
  ├─ handler
  ├─ response validation (response schema)
  ├─ response filters (createApp and plugins, then router)
  │
  ├─ CORS headers
  ├─ onResponse hooks (plugins)
  ▼
response
```

Any step can stop the pipeline with an error or a response: the following steps are skipped, and the response still gets its CORS headers and goes through the `onResponse` hooks.

## Middlewares run before validation

Middlewares run **before** the request is validated. An unauthenticated request with an invalid body gets the `401` of the authentication middleware, not a `400`: the API does not reveal its validation rules to anonymous clients, and does not spend time validating requests it rejects anyway.

As a consequence, a middleware sees the raw values received by the adapter (`ctx.req.params`, `query` and `body`, not yet parsed by the schemas), while the handler sees the validated values.

A middleware returns nothing to continue, or an error or a response to stop the pipeline:

```ts
const requireApiKey = defineMiddleware((ctx) => {
  if (ctx.req.header('x-api-key') !== apiKey) return unauthorizedError()
})
```

See [Middlewares and filters](/routing/middlewares).

## The handler's value becomes the response

The handler returns a value, and Dotpress builds the response:

| The handler returns | Response |
| --- | --- |
| a value | JSON, with the route `status` (`200` by default) |
| nothing | `204 No Content`, or the route `status` |
| an error (`notFoundError()`…) | the error, in the [standard format](./errors) |
| a response helper (`text()`, `redirect()`, `stream()`, `sse()`, `file()`…) | that response |

JSON values are checked against the `response` schema, when the route has one, then go through the response filters. Raw responses (text, streams, files) skip both.

## Errors

A step that throws or returns an error stops the pipeline:

- an `HttpError` (`notFoundError()`, `forbiddenError()`…), thrown or returned, becomes its response;
- anything else is unexpected: the error is logged with the request ID, passed to the `onError` hook, and the client gets a `500` without details (unless `exposeErrors` is enabled, in development).

See [Returned errors](./errors).

## Hooks

Plugins can act around the pipeline:

- **`onRequest`** runs before the middlewares, for the requests matching a route;
- **`wrapRequest`** runs the whole pipeline of a request inside a function: request-scoped storage, tracing spans;
- **`onResponse`** receives every response, including `404` and `405`, with the request, the request ID and the duration: request logging, metrics. It can replace the response.

See [Logging and error hooks](/routing/logging) and [Plugins](/routing/plugins).
