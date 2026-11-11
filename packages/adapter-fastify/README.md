# @dotpress/adapter-fastify

[Fastify](https://fastify.dev) adapter for [Dotpress](https://dotpress.dev), on Node.js and AWS Lambda. Supports Fastify 5.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

```sh
pnpm add @dotpress/core @dotpress/adapter-fastify fastify zod
```

```ts
import { createApp, defineRoute } from '@dotpress/core'
import { fastifyAdapter } from '@dotpress/adapter-fastify'
import helmet from '@fastify/helmet'

defineRoute({ path: '/hello', handler: () => ({ message: 'Hello' }) })

const app = await createApp({
  adapter: fastifyAdapter({
    // Fastify plugins and hooks applied to the Dotpress routes
    beforeRoutes: async (app) => {
      await app.register(helmet)
    },
  }),
})

await app.listen(3000)
```

## Options

| Option | Description |
| --- | --- |
| `app` | Existing Fastify instance. Defaults to `Fastify()`. |
| `beforeRoutes(app)` | Registers hooks, plugins and native routes. Hooks registered here apply to the Dotpress routes. |
| `afterRoutes(app)` | Registers hooks, plugins and native routes in an encapsulated context: they do not apply to the Dotpress routes, except plugins wrapped with `fastify-plugin`, which apply to the parent context. |
| `bodyLimit` | Maximum request body size in bytes. Defaults to 1 MiB. |

## Behavior

- **Routes.** Each Dotpress route is a native Fastify route: the route path (`request.routeOptions.url`, `/users/:id`) shows in Fastify logs, metrics and traces, and a native route with the same method and path fails at startup. Routing follows the Dotpress rules whatever the router options: trailing slashes are ignored, `HEAD` requests use the `GET` routes, and unsupported methods get `405` with an `Allow` header. Between native and Dotpress routes, the most specific path wins (Fastify routing), whatever the registration order.
- **Bodies.** Dotpress reads the bodies of its routes, with the same rules on every adapter: the Fastify body parsers only apply to native routes, and `@fastify/multipart` is not needed for uploads. `preParsing` hooks apply. Like Fastify, the adapter does not read the bodies of `GET` and `HEAD` requests, and rejects invalid `Content-Type` headers (`415`).
- **Errors.** Errors with a 4xx `statusCode` raised by Fastify or its plugins (`@fastify/rate-limit`, `@fastify/sensible`…) use the Dotpress error format and keep their status and message. Other errors are unexpected errors (`500`). The adapter takes over the not-found and error handlers of the instance: they apply to native routes too.
- **`ctx.req.ip`** is `request.ip`: proxy headers are only used with the `trustProxy` option of Fastify.
- **Streamed responses** (`stream()`, `sse()`) are written directly to the Node.js response, so that their headers are sent immediately: `onSend` hooks (`@fastify/compress`…) do not apply to them. The headers set by earlier hooks are kept.
- `ctx.raw` is the Fastify request.
- The instance is ready once `createApp()` resolves: register plugins and routes in `beforeRoutes` or `afterRoutes`.
- `listen(port, host?)` listens on every interface without `host`, like Node.js. `close()` closes the Fastify instance (`onClose` hooks of the plugins), waits for pending requests, and closes the responses being streamed. `adapter.server()` returns the Node.js HTTP server while listening.

To test without opening a port, use `inject()` of Fastify:

```ts
const adapter = fastifyAdapter()
await createApp({ adapter })
const res = await adapter.native().inject('/hello')
```

## On AWS Lambda

```sh
pnpm add @dotpress/core @dotpress/adapter-fastify fastify @fastify/aws-lambda zod
```

```ts
import { createApp } from '@dotpress/core'
import { fastifyAdapter } from '@dotpress/adapter-fastify'
import { createLambdaHandler } from '@dotpress/adapter-fastify/lambda'

export const handler = createLambdaHandler(() =>
  createApp({ adapter: fastifyAdapter(), plugins: [/* ... */] })
)
```

`createLambdaHandler()` (based on [`@fastify/aws-lambda`](https://github.com/fastify/aws-lambda-fastify) 6.1 or later, which sends the events to `inject()`) handles the events of API Gateway REST APIs (payload v1), HTTP APIs and Function URLs (payload v2), and Application Load Balancers, with or without multi-value headers. Enable the multi-value headers of the target group to receive repeated query keys and send several cookies through a load balancer.

- **Lazy creation.** The factory is called at the first invocation (cold start), and the app is reused by the next invocations of the execution environment. Invocations received meanwhile wait for the same app. The handler export stays synchronous: no top-level `await`.
- **Recoverable failures.** When the factory fails, the error is logged (`logger` option, console by default), the invocation gets the standard `500` error, and the next invocation calls the factory again.
- **Buffered responses.** Responses are sent once complete: `stream()` works for finite streams, but Server-Sent Events (`sse()`) are not supported, and a stream that fails gets an empty `500` response rather than a truncated one. Lambda response streaming is not supported yet.
- **Binary responses** are sent in base64: compressed responses, and every content type except text, JSON and XML by default, or as decided by the `isContentTypeBinary(contentType)` option.
- **Query strings** are read as sent when the event has them (payload v2, load balancers): plus signs and commas keep their meaning, like on the other adapters.
- **`ctx.req.ip`** is the source IP of API Gateway, or the last `X-Forwarded-For` entry behind a load balancer (appended by the load balancer); `127.0.0.1` when the event has no address. With the `trustProxy` option, Fastify reads `X-Forwarded-For` instead.
- The Lambda event and context are not given to the routes: `request.awsLambda` of `@fastify/aws-lambda` needs a decoration before the instance is ready.

## License

MIT
