# @dotpress/adapter-fastify

[Fastify](https://fastify.dev) adapter for [Dotpress](https://dotpress.dev). Supports Fastify 5.

> 🚧 Dotpress V2 is under active development and not published yet.

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

## License

MIT
