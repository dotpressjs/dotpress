# Responses and errors

What a handler returns: values, response helpers and errors. For a guide, see [Responses](/routing/responses) and [Errors](/routing/errors).

## What a handler returns

| Value | Response |
| --- | --- |
| A value (object, array, string, number…) | JSON, with the status of the route (`200` by default). Validated by `schema.response`, then filtered. |
| `undefined` | `204 No Content`, or the status set with `res.setStatus()` or the route `status`. |
| `json(data, init)` | JSON with an explicit status or headers. Validated and filtered like a value. |
| `text()`, `redirect()`, `stream()`, `sse()`, `file()`, `empty()` | Sent as is: no response validation, no filters. |
| An `HttpError` | The error response. Returning it or throwing it gives the same response. |
| Anything thrown, except an `HttpError` | `500 INTERNAL_ERROR`, logged and passed to `onError`. |

## Response helpers

All of them are exported by `@dotpress/core`. `init` accepts `status` and `headers`; headers set on `ctx.res` are merged.

| Helper | Response |
| --- | --- |
| `json(data, init?)` | JSON. |
| `text(body, init?)` | Plain text, `text/plain; charset=utf-8` unless a `content-type` header is given. |
| `redirect(location, { status?, headers? })` | A redirect, `302` by default: `301`, `302`, `303`, `307` or `308`. |
| `stream(source, init?)` | A streamed body. `init.contentType` defaults to `application/octet-stream`. |
| `sse(source, init?)` | Server-Sent Events. `init.heartbeat` in milliseconds, `15000` by default, or `false`. |
| `file(body, init?)` | A download: `filename`, `contentType`, `disposition` (`attachment` by default, or `inline`). |
| `empty(init?)` | No body, `204` by default. |

```ts
handler: ({ req, res }) => {
  res.setHeader('Cache-Control', 'no-store')
  return json(created, { status: 201, headers: { Location: `/tasks/${created.id}` } })
}
```

`redirect()` sends the location as given: behind a proxy, build it with `ctx.publicPath('/login')`.

### stream()

The source is a `ReadableStream`, an iterable, an async iterable, or a function returning one. A function receives `{ signal }`, aborted when the client disconnects. Chunks are strings, encoded as UTF-8, or `Uint8Array`. A string or a `Uint8Array` given as the source is one chunk.

```ts
return stream(async function* ({ signal }) {
  for await (const row of db.export({ signal })) yield `${row.csv}\n`
}, { contentType: 'text/csv' })
```

### sse()

The source yields events, or strings sent as `data`:

| Field | Description |
| --- | --- |
| `data` | The payload. Strings are sent as is, other values as JSON. |
| `event` | The type of the event, `message` on the client by default. |
| `id` | Sent back by the browser as `Last-Event-ID` when it reconnects. |
| `retry` | Reconnection delay for the browser, in milliseconds. |
| `comment` | A comment line, ignored by the browser. |

`sse()` sets `Content-Type: text/event-stream`, `Cache-Control: no-cache` and `X-Accel-Buffering: no` (no buffering in nginx).

### file()

`body` is a `Uint8Array`, an `ArrayBuffer`, a `Blob` or a `ReadableStream`. The content type defaults to the type of the `Blob`, else `application/octet-stream`. `Content-Length` is set when the size is known, and `filename` is encoded for non-ASCII names.

```ts
return file(pdf, { filename: 'invoice-2026-001.pdf', contentType: 'application/pdf' })
```

## Error helpers

Each one returns an `HttpError`: `return notFoundError()` or `throw notFoundError()`. `message` replaces the default message. The options:

| Option | Description |
| --- | --- |
| `data` | Details added to the body: `notFoundError('Task not found', { data: { id } })`. |
| `cause` | The original error (`error.cause`), for the logs and `onError`. Never sent. |

Unknown options are rejected: `notFoundError('Task not found', { id })` throws a `TypeError`.

| Helper | Status | `error` code | Default message |
| --- | --- | --- | --- |
| `badRequestError(message?, options?)` | 400 | `BAD_REQUEST` | Bad Request |
| `unauthorizedError(message?, options?)` | 401 | `UNAUTHORIZED` | Unauthorized |
| `forbiddenError(message?, options?)` | 403 | `FORBIDDEN` | Forbidden |
| `notFoundError(message?, options?)` | 404 | `NOT_FOUND` | Not Found |
| `conflictError(message?, options?)` | 409 | `CONFLICT` | Conflict |
| `unprocessableError(message?, options?)` | 422 | `UNPROCESSABLE_ENTITY` | Unprocessable Entity |
| `tooManyRequestsError(message?, options?)` | 429 | `TOO_MANY_REQUESTS` | Too Many Requests |
| `internalError(message?, options?)` | 500 | `INTERNAL_ERROR` | Internal Server Error |
| `errorResponse(status, code, message, options?)` | any | any | — |

### Errors produced by Dotpress

| Status | `error` code | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | The request does not match the schema of the route. `data.issues` lists every issue. |
| 400 | `MALFORMED_BODY` | The body cannot be parsed: invalid JSON, UTF-8 or multipart. |
| 404 | `NOT_FOUND` | No route matches the path (`Route not found`). |
| 405 | `METHOD_NOT_ALLOWED` | The path exists for other methods. The `Allow` header lists them. |
| 413 | `PAYLOAD_TOO_LARGE` | The body exceeds the limit of the route or of the adapter. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | A `Content-Encoding` other than `identity`, or an unknown charset. |
| 500 | `INTERNAL_ERROR` | An unexpected error, or a response that does not match `schema.response`. |

Validation issues have this shape:

```ts
interface ValidationIssue {
  source: 'params' | 'query' | 'body' | 'files'
  path: (string | number)[]
  code: string // the Zod issue code: 'invalid_type', 'too_small'…
  message: string
}
```

## Error body

Every error response has the same JSON body:

```ts
interface ErrorBody {
  status: number
  error: string
  message: string
  data?: Record<string, unknown>
}
```

```json
{ "status": 404, "error": "NOT_FOUND", "message": "Task not found" }
```

With `exposeErrors: true`, the `data` of a `500` holds the `name`, `message` and `stack` of the error, and the `issues` of an invalid response. Never in production.

## HttpError

```ts
class HttpError extends Error {
  constructor(
    status: number, // 400 to 599
    code: string,
    message: string,
    options?: { data?: Record<string, unknown>; cause?: unknown }
  )
  readonly status: number
  readonly code: string
  readonly data: Record<string, unknown> | undefined
  toJSON(): ErrorBody
}
```

Subclass it, or wrap `errorResponse()`, for the errors of your domain:

```ts
export const quotaExceededError = (limit: number) =>
  errorResponse(402, 'QUOTA_EXCEEDED', 'Quota exceeded', { data: { limit } })
```

`isHttpError(value)` recognizes an `HttpError`, even one created by another copy of `@dotpress/core`. `toErrorBody(error)` returns its body.

Headers set on `ctx.res` are kept on the response of an `HttpError`, not on the `500` of an unexpected error. See [Custom errors](/routing/errors#custom-errors) and [Unexpected errors](/routing/errors#unexpected-errors).
