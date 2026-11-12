# Responses

A handler returns its response. It never writes to the native response object: Dotpress builds the response, on every adapter the same way.

## Return a value

| The handler returns | Response |
| --- | --- |
| a value (object, array, string, number…) | `200` JSON, or the route `status` |
| nothing (`undefined`) | `204 No Content`, or the route `status` |
| an error (`notFoundError()`…) | the error, in the [standard format](/concepts/errors) |
| a response helper | the response it describes |

```ts twoslash
import { defineRoute } from '@dotpress/core'

declare const jobs: { enqueue(name: string): Promise<{ id: string }>; cancel(id: string): Promise<void> }
// ---cut---
defineRoute({
  method: 'post',
  path: '/jobs',
  status: 202,
  handler: () => jobs.enqueue('export'),
})

defineRoute({
  method: 'delete',
  path: '/jobs/:id',
  handler: async ({ req }) => {
    await jobs.cancel(req.params.id)
  },
})
```

The first route answers `202` with the job as JSON; the second, `204` without body.

## Status, headers and cookies

`ctx.res` sets the metadata of the response, whatever the handler returns:

```ts twoslash
import { defineRoute } from '@dotpress/core'
declare const createSession: () => Promise<{ id: string; token: string }>
// ---cut---
defineRoute({
  method: 'post',
  path: '/sessions',
  handler: async ({ res }) => {
    const session = await createSession()
    res
      .setStatus(201)
      .setHeader('cache-control', 'no-store')
      .setCookie('session', session.token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24,
      })
    return { id: session.id }
  },
})
```

| Method | Effect |
| --- | --- |
| `setStatus(status)` | Status of the response |
| `setHeader(name, value)` | Sets a header, replacing its value |
| `appendHeader(name, value)` | Adds a value to a header |
| `removeHeader(name)` | Removes a header |
| `setCookie(name, value, options)` | Adds a `Set-Cookie` header |
| `clearCookie(name, options)` | Expires a cookie: use the `path` and `domain` it was set with |

Headers and cookies are kept on error responses returned or thrown as `HttpError`, and dropped on unexpected errors (`500`).

:::warning Cookie security
`setCookie()` only applies the options you give, with `path: '/'` by default. For a session or any secret, set `httpOnly: true` (out of reach of the JavaScript of the page), `secure: true` (HTTPS only) and `sameSite`. For authentication, prefer the [cookie mode of `@dotpress/auth`](/auth/cookies), which sets them for you.
:::

Request cookies are parsed: `ctx.req.cookies.session`.

## Response helpers

For anything other than plain JSON, return a helper from `@dotpress/core`:

```ts
return json(data, { status: 201, headers: { location: '/members/1' } })
return text('OK')
return redirect('/login') // 302; or 301, 303, 307, 308
return file(bytes, { filename: 'invoice.pdf', contentType: 'application/pdf' })
return stream(source, { contentType: 'text/csv' })
return sse(source)
return empty({ status: 202 })
```

| Helper | Response |
| --- | --- |
| `json(data, init)` | JSON with a status and headers. Still validated by the `response` schema and filtered. |
| `text(body, init)` | `text/plain; charset=utf-8`, or the `content-type` of `init.headers` (HTML, CSV…) |
| `redirect(location, status)` | A redirect, `302` by default |
| `file(body, init)` | A download: `Uint8Array`, `ArrayBuffer`, `Blob` or `ReadableStream`, with a `filename` and `disposition` (`attachment` or `inline`) |
| `stream(source, init)` | A streamed body |
| `sse(source, init)` | Server-Sent Events |
| `empty(init)` | No body: `204` by default |

Responses other than `json()` skip the `response` schema and the response filters.

Redirects are not prefixed with the [base path](./http-options#base-path) of the app: use `ctx.publicPath('/login')` to redirect to a route of the app behind a proxy.

## Streams

`stream()` sends the body as it is produced. The source is a `ReadableStream`, an iterable, an async iterable, or a function returning one: typically an async generator, which receives the abort signal of the request.

```ts twoslash
import { defineRoute, stream } from '@dotpress/core'

declare const orders: {
  export(options: { signal: AbortSignal }): AsyncIterable<{ id: string; total: number }>
}
// ---cut---
defineRoute({
  path: '/orders/export',
  handler: () =>
    stream(
      async function* ({ signal }) {
        yield 'id,total\n'
        for await (const order of orders.export({ signal })) {
          yield `${order.id},${order.total}\n`
        }
      },
      { contentType: 'text/csv' }
    ),
})
```

When the client disconnects, the signal is aborted and the generator stops: its `finally` blocks run, so the database cursor is released.

## Server-Sent Events

`sse()` sends events to the browser, which reads them with `EventSource`. Each event is a string, or an object with `data` (sent as JSON when it is not a string), `event`, `id`, `retry` or `comment`:

```ts twoslash
import { defineRoute, sse } from '@dotpress/core'

declare const notifications: {
  watch(options: { signal: AbortSignal }): AsyncIterable<{ id: string; text: string }>
}
// ---cut---
defineRoute({
  path: '/notifications/live',
  handler: () =>
    sse(async function* ({ signal }) {
      for await (const notification of notifications.watch({ signal })) {
        yield { event: 'notification', id: notification.id, data: notification }
      }
    }),
})
```

A comment is sent every 15 seconds to keep the connection open through proxies (`heartbeat` option, `false` to disable it).

An error raised by a stream after the response has started is logged and reported to `onError`, and the connection is closed: the status was already sent.

## Client disconnections

`ctx.req.signal` is aborted when the client goes away. Pass it to long operations, so that they stop instead of working for nobody:

```ts
handler: async ({ req }) => {
  const report = await fetch(reportServiceUrl, { signal: req.signal })
  return report.json()
}
```

:::tip Coming from v1
Handlers no longer receive the Express `res`: return the value, and use `ctx.res` for the status, headers and cookies. Returning nothing now always answers `204`.
:::
