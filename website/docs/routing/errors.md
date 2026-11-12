# Errors

Handlers and middlewares return their errors, built with the helpers of `@dotpress/core`. This page lists them, the errors Dotpress produces itself, and how to report the unexpected ones. For the principles, see [Returned errors](/concepts/errors).

## Returning an error

```ts twoslash
import { defineRoute, forbiddenError, notFoundError } from '@dotpress/core'

declare const documents: {
  find(id: string): Promise<{ id: string; ownerId: string } | undefined>
}
declare module '@dotpress/core' {
  interface RequestContext {
    userId?: string
  }
}
// ---cut---
defineRoute({
  path: '/documents/:id',
  handler: async ({ req, userId }) => {
    const document = await documents.find(req.params.id)
    if (!document) return notFoundError('Document not found')
    if (document.ownerId !== userId) return forbiddenError()
    return document
  },
})
```

| Helper | Status | `error` |
| --- | --- | --- |
| `badRequestError(message?, data?)` | 400 | `BAD_REQUEST` |
| `unauthorizedError(message?, data?)` | 401 | `UNAUTHORIZED` |
| `forbiddenError(message?, data?)` | 403 | `FORBIDDEN` |
| `notFoundError(message?, data?)` | 404 | `NOT_FOUND` |
| `conflictError(message?, data?)` | 409 | `CONFLICT` |
| `unprocessableError(message?, data?)` | 422 | `UNPROCESSABLE_ENTITY` |
| `tooManyRequestsError(message?, data?)` | 429 | `TOO_MANY_REQUESTS` |
| `internalError(message?, data?)` | 500 | `INTERNAL_ERROR` |

Without a message, each uses the standard reason phrase (`Not Found`).

## Custom errors

`errorResponse(status, code, message, data)` builds any other error. Use stable codes: clients test them.

```ts
return errorResponse(422, 'INVALID_STATE', 'Invalid state transition', {
  state: 'archived',
  previousState: 'pending',
})
```

```json
{
  "status": 422,
  "error": "INVALID_STATE",
  "message": "Invalid state transition",
  "data": { "state": "archived", "previousState": "pending" }
}
```

`data` is sent to the client: never put internal details in it.

All helpers return an `HttpError`, which can also be thrown, with the same result. `isHttpError(value)` recognizes one.

## Errors produced by Dotpress

| Status | `error` | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | The request does not match the schemas of the route. `data.issues` lists the issues. |
| 400 | `MALFORMED_BODY` | The body cannot be parsed: invalid JSON, UTF-8 or multipart. |
| 404 | `NOT_FOUND` | No route matches the path (`Route not found`). |
| 405 | `METHOD_NOT_ALLOWED` | The path exists, for other methods only. The `Allow` header lists them. |
| 413 | `PAYLOAD_TOO_LARGE` | The body exceeds the [body limit](./bodies#body-size-limit). |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Compressed body (`Content-Encoding`), or unknown charset. |
| 500 | `INTERNAL_ERROR` | An unexpected error (see below). |

These responses use the standard format too, and get the CORS headers: a browser client can read them.

## Unexpected errors

An exception that is not an `HttpError` is unexpected: a bug, a database failure, a timeout. Dotpress:

1. logs it with the request logger, so the log line carries the request ID;
2. passes it to the `onError` hooks;
3. answers `500 INTERNAL_ERROR`, without any detail: an exception message can reveal a query, a path or a secret.

The response carries the `X-Request-ID` header: a client reporting a problem gives it, and you find the log line.

### Reporting errors

`onError` receives every unexpected error, with the request context (`undefined` when the error happened outside a route):

```ts
import * as Sentry from '@sentry/node'

const app = await createApp({
  adapter,
  onError: (error, ctx) => {
    Sentry.captureException(error, { tags: { requestId: ctx?.requestId } })
  },
})
```

Plugins add their own hooks with `api.onError()`. A failing hook is logged, and never changes the response.

### Details in development

`exposeErrors: true` adds the `name`, `message` and `stack` of the error to the `data` of `500` responses, and the issues when a response does not match its schema:

```ts
const app = await createApp({ adapter, exposeErrors: config.env === 'development' })
```

:::danger
Never enable `exposeErrors` in production. Dotpress never reads `NODE_ENV` or any environment variable itself: the decision is yours, explicit.
:::

## Errors of native middlewares

Errors passed to `next(error)` by native Express middlewares are converted to the standard format: a client error (a `status` from 400 to 499) keeps its status, anything else is a `500` reported to `onError`.

:::tip Coming from v1
`isDev` is replaced by `exposeErrors`, and `onException` by `onError`. A thrown `HttpError` now gives the same response as a returned one (Dotpress 1 answered `500`), and the `404` and `500` produced by the framework use the standard format.
:::
