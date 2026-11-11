# @dotpress/adapter-hono

[Hono](https://hono.dev) adapter for [Dotpress](https://dotpress.dev), on Node.js and AWS Lambda. Supports Hono 4 (4.13 or later); Hono 5 is tested against its release candidate.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

## On Node.js

```sh
pnpm add @dotpress/core @dotpress/adapter-hono hono @hono/node-server zod
```

```ts
import { createApp, defineRoute } from '@dotpress/core'
import { honoAdapter } from '@dotpress/adapter-hono/node'
import { secureHeaders } from 'hono/secure-headers'

defineRoute({ path: '/hello', handler: () => ({ message: 'Hello' }) })

const app = await createApp({
  adapter: honoAdapter({
    // Native Hono middlewares, before the Dotpress routes
    beforeRoutes: (app) => {
      app.use('*', secureHeaders())
    },
  }),
})

await app.listen(3000)
```

`@dotpress/adapter-hono/node` serves the app with [`@hono/node-server`](https://github.com/honojs/node-server). `close()` waits for pending requests and closes the responses being streamed (Server-Sent Events); `adapter.server()` returns the Node.js HTTP server started by `listen()`.

## On AWS Lambda

```sh
pnpm add @dotpress/core @dotpress/adapter-hono hono @hono/aws-lambda zod
```

```ts
import { createApp } from '@dotpress/core'
import { honoAdapter } from '@dotpress/adapter-hono'
import { createLambdaHandler } from '@dotpress/adapter-hono/lambda'

export const handler = createLambdaHandler(() =>
  createApp({ adapter: honoAdapter(), plugins: [/* ... */] })
)
```

`createLambdaHandler()` (based on [`@hono/aws-lambda`](https://github.com/honojs/middleware), which requires Hono 4.13.9 or later) handles the events of API Gateway REST APIs (payload v1), HTTP APIs and Function URLs (payload v2), and Application Load Balancers. Enable the multi-value headers of the target group to receive repeated query keys and send several cookies through a load balancer.

- **Lazy creation.** The factory is called at the first invocation (cold start), and the app is reused by the next invocations of the execution environment. Invocations received meanwhile wait for the same app. The handler export stays synchronous: no top-level `await`.
- **Recoverable failures.** When the factory fails, the error is logged (`logger` option, console by default), the invocation gets the standard `500` error, and the next invocation calls the factory again.
- **Buffered responses.** Responses are sent once complete: `stream()` works for finite streams, but Server-Sent Events (`sse()`) are not supported, and a stream that fails makes the invocation fail (`502` from API Gateway) rather than sending a truncated response. Lambda response streaming is not supported yet.
- **Binary responses** are sent in base64: every content type except text, JSON and XML by default, or as decided by the `isContentTypeBinary(contentType)` option.
- **`ctx.req.ip`** is the source IP of API Gateway, or the last `X-Forwarded-For` entry behind a load balancer (appended by the load balancer). Behind CloudFront or another proxy, use the `getIp(c)` option of `honoAdapter()`.

## Other runtimes

The main entry, `@dotpress/adapter-hono`, only relies on Hono and Web-standard APIs: no Node.js server. `adapter.fetch` handles a Web `Request`, like `app.fetch` in Hono, for runtimes that take a `fetch` handler:

```ts
import { honoAdapter } from '@dotpress/adapter-hono'

const adapter = honoAdapter()
await createApp({ adapter })

export default { fetch: adapter.fetch }
```

Outside Node.js, `ctx.req.ip` comes from the `getIp(c)` option. Dotpress V2.0 is only tested on Node.js: other runtimes are not officially supported yet.

## Options

| Option | Description |
| --- | --- |
| `app` | Existing Hono application. Defaults to `new Hono()`. |
| `beforeRoutes(app)` | Registers native middlewares and routes before the Dotpress routes. |
| `afterRoutes(app)` | Registers native middlewares and routes after the Dotpress routes, before the not-found handler. |
| `bodyLimit` | Maximum request body size in bytes. Defaults to 1 MiB. |
| `getIp(c)` | Client IP address (`ctx.req.ip`). Defaults to the address given by the runtime: the socket address on Node.js, see below for AWS Lambda. |

## Behavior

- Routes are matched by Dotpress, so they behave the same on every adapter (case-sensitive, static segments before parameters, Hono options such as `strict` do not apply). Use the `basePath` option of `createApp()` rather than `app.basePath()`.
- Request bodies are read by the adapter: JSON, URL-encoded forms, text and multipart forms are parsed, other content types are exposed as `Uint8Array`. Bodies already read by a native middleware through Hono (`c.req.json()`, `c.req.parseBody()`…) are taken from its cache. Routes declared with `rawBody: true` need the exact bytes: the adapter must read the body, or a native middleware must read it with `c.req.arrayBuffer()` or `c.req.blob()`.
- `HTTPException` client errors (4xx) thrown by native middlewares use the Dotpress error format and keep their status, message and headers (`WWW-Authenticate` of `bearerAuth()`…). Other errors are unexpected errors (`500`). The adapter takes over `app.notFound()` and `app.onError()`.
- `ctx.req.ip` does not read proxy headers such as `X-Forwarded-For`: behind a proxy, read them in `getIp(c)`.
- `ctx.raw` is the Hono context.

## License

MIT
