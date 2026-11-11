# @dotpress/adapter-express

[Express](https://expressjs.com) adapter for [Dotpress](https://dotpress.dev). Supports Express 4 and 5.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

```sh
pnpm add @dotpress/core @dotpress/adapter-express express zod
```

```ts
import { createApp, defineRoute } from '@dotpress/core'
import { expressAdapter } from '@dotpress/adapter-express'
import helmet from 'helmet'

defineRoute({ path: '/hello', handler: () => ({ message: 'Hello' }) })

const app = await createApp({
  adapter: expressAdapter({
    // Native Express middlewares, before the Dotpress routes
    beforeRoutes: (app) => {
      app.use(helmet())
    },
  }),
})

await app.listen(3000)
```

## Options

| Option | Description |
| --- | --- |
| `app` | Existing Express application (Express 4 or 5). Defaults to a new `express()` application, with `X-Powered-By` and `ETag` disabled. |
| `beforeRoutes(app)` | Registers native middlewares before the Dotpress routes. |
| `afterRoutes(app)` | Registers native middlewares and routes after the Dotpress routes, before the not-found handler. |
| `bodyLimit` | Maximum request body size in bytes. Defaults to 1 MiB. |

## Behavior

- Routes are matched by Dotpress, so they behave the same on every adapter (case-sensitive, static segments before parameters, Express settings such as `case sensitive routing` do not apply).
- Request bodies are read by the adapter: JSON, URL-encoded forms and text are parsed, other content types are exposed as `Uint8Array`. Bodies already parsed by a native middleware (`express.json()`, `multer`…) are used as is.
- Routes declared with `rawBody: true` need the adapter to read the body: do not register a native body parser for them.
- Errors passed to `next(error)` by native middlewares use the Dotpress error format. Client errors (`status` 4xx) keep their status.
- `ctx.raw` is the Express request.
- `close()` waits for pending requests and closes the responses being streamed (Server-Sent Events).
- `adapter.server()` returns the Node.js HTTP server started by `listen()`.

To use your own HTTP server, mount the Express application yourself:

```ts
const app = await createApp({ adapter: expressAdapter() })
https.createServer(tlsOptions, app.native()).listen(443)
```

## License

MIT
