# Adapters

The adapters of `@dotpress/adapter-express`, `@dotpress/adapter-fastify` and `@dotpress/adapter-hono`, and their AWS Lambda handlers. For a guide, see [Adapters](/adapters/).

## Options

Every adapter takes the same options, and rejects unknown ones:

| Option | Default | Description |
| --- | --- | --- |
| `app` | a new application | The Express, Fastify or Hono application to mount the routes on, with its own settings. |
| `beforeRoutes(app)` | — | Registers native middlewares, hooks and routes before the Dotpress routes. |
| `afterRoutes(app)` | — | Registers native middlewares and routes after them. With Fastify, in an encapsulated context: they do not apply to the Dotpress routes. |
| `bodyLimit` | `1048576` (1 MiB) | Maximum body size, in bytes. A route overrides it with its own `bodyLimit`. |
| `getIp(c)` | the address of the connection | Hono only: the IP address of a request, for instance from a header set by your proxy. |

The option types take the application as a parameter, with a default: `ExpressAdapterOptions` is `ExpressAdapterOptions<Express>`, `FastifyAdapterOptions` is `FastifyAdapterOptions<FastifyInstance>`, `HonoAdapterOptions` is `HonoAdapterOptions<Hono>`.

## expressAdapter()

```ts
import { expressAdapter } from '@dotpress/adapter-express'

const adapter = expressAdapter({ bodyLimit: 5 * 1024 * 1024 })
```

| Member | Description |
| --- | --- |
| `native()` | The Express application, also `app.native()`. |
| `listen(port, host?)` | Starts an HTTP server, and returns `{ port, host }`. Refuses a second call. |
| `close()` | Stops the server started by `listen()`, after the pending requests, and closes the responses being streamed, also when the app serves the Express application with its own server. |
| `server()` | The HTTP server started by `listen()`, or `undefined`. |

Express 4 and 5 are supported. `@types/express` types `native()`: without it, the application is `any`. See [Express](/adapters/express).

## fastifyAdapter()

```ts
import { fastifyAdapter } from '@dotpress/adapter-fastify'

const adapter = fastifyAdapter({ app: Fastify({ trustProxy: true }) })
```

| Member | Description |
| --- | --- |
| `native()` | The Fastify instance. |
| `listen(port, host?)` | Starts the server (`::`, or `0.0.0.0` without IPv6, by default), and returns `{ port, host }`. Refuses a second call. |
| `close()` | Closes the responses being streamed, then the Fastify instance. |
| `server()` | The HTTP server, once listening. |

See [Fastify](/adapters/fastify).

## honoAdapter()

```ts
import { honoAdapter } from '@dotpress/adapter-hono' // fetch: Bun, Deno, Workers…
import { honoAdapter } from '@dotpress/adapter-hono/node' // Node.js server
```

| Member | Entry | Description |
| --- | --- | --- |
| `native()` | both | The Hono application. |
| `fetch(request, env?, executionContext?)` | both | Handles a Web `Request`. |
| `close()` | both | Closes the responses being streamed. |
| `listen(port, host?)` | `/node` | Starts a Node.js server (`@hono/node-server`), and returns `{ port, host }`. Refuses a second call. |
| `server()` | `/node` | The Node.js server, once listening. |

See [Hono](/adapters/hono).

## createLambdaHandler()

```ts
import { createLambdaHandler } from '@dotpress/adapter-hono/lambda'
// or '@dotpress/adapter-fastify/lambda'

export const handler = createLambdaHandler(() => createApp({ adapter: honoAdapter() }))
```

Both entries export the same function and types. The factory creates the app at the first invocation; its failures are logged, answered with a `500`, and retried at the next invocation.

| Option | Default | Description |
| --- | --- | --- |
| `logger` | a console logger | Logs the failures to create the app. |
| `isContentTypeBinary(contentType)` | everything but text, JSON and XML | Whether a response is sent in base64. |

| Type | Description |
| --- | --- |
| `LambdaEvent` | An event of API Gateway (payload v1 or v2), a Function URL or an Application Load Balancer: the types of `@types/aws-lambda` fit. |
| `LambdaContext` | The context of the invocation. |
| `LambdaResult` | The result, in the format of the event: `statusCode`, `headers`, `multiValueHeaders`, `cookies`, `body`, `isBase64Encoded`, and `statusDescription` for load balancers. |
| `LambdaHandler` | `(event, context?) => Promise<LambdaResult>`. |
| `LambdaApp` | What the factory returns: an app created with the adapter of the entry. |

See [AWS Lambda](/adapters/aws-lambda).

## Writing an adapter

An adapter implements `HttpAdapter` of `@dotpress/core`, with the functions of `@dotpress/core/adapter`: see [For adapter authors](./application#for-adapter-authors). The [conformance suite](/services/testing#writing-an-adapter) checks it.
