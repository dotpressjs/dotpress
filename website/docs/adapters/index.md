# Choosing an adapter

An adapter connects your app to an HTTP server. Your routes, middlewares, errors and tests do not depend on it: switching from one adapter to another changes one line of `createApp()`.

```ts
// Express
const app = await createApp({ adapter: expressAdapter(), routers })
// Fastify
const app = await createApp({ adapter: fastifyAdapter(), routers })
// Hono, on Node.js
const app = await createApp({ adapter: honoAdapter(), routers })
```

## Compared

| | Express | Fastify | Hono |
| --- | --- | --- | --- |
| Package | `@dotpress/adapter-express` | `@dotpress/adapter-fastify` | `@dotpress/adapter-hono` |
| Versions | Express 4 and 5 | Fastify 5 | Hono 4.13 or later |
| Node.js server | ✓ | ✓ | ✓, with `@hono/node-server` |
| AWS Lambda | — | ✓ | ✓ |
| Native extensions | Express middlewares | Fastify plugins and hooks | Hono middlewares |
| Lambda bundle (example, minified) | — | about 1.1 MB | about 510 kB |

## Which one?

- **Your team knows one of them, or your app already runs on it**: take that one. Mount Dotpress on your existing application, next to its native routes, and move them over time.
- **You need middlewares or plugins of a specific ecosystem** (`helmet`, `@fastify/rate-limit`, Hono middlewares…): take the server of that ecosystem.
- **The API runs on AWS Lambda**: take Hono for the smallest bundle, or Fastify if you need its plugins.
- **No preference**: any of them works the same with Dotpress. You can change your mind later.

Coming from Dotpress 1, which ran on Express: keep [Express](./express) to migrate in small steps.

## The same behavior everywhere

Whatever the adapter, Dotpress itself:

- **matches the routes**, with the same rules: case-sensitive, static segments before parameters, trailing slashes ignored, `405` with an `Allow` header;
- **reads and parses the bodies**: JSON, forms, text, multipart uploads, with the same size limit and errors;
- **builds the responses**, including streams and Server-Sent Events;
- **formats the errors**, including the client errors of native middlewares (a `4xx` keeps its status).

Every adapter passes the same conformance test suite of `@dotpress/testing`, which covers routing, parsing, validation, errors, middlewares and responses.

## Common options

| Option | Description |
| --- | --- |
| `app` | An existing Express, Fastify or Hono application. A new one by default. |
| `beforeRoutes(app)` | Registers native middlewares, plugins and routes before the Dotpress routes. |
| `afterRoutes(app)` | Registers native middlewares and routes after the Dotpress routes. |
| `bodyLimit` | Maximum request body size, in bytes. 1 MiB by default. |

The app also gives access to the server:

- `app.native()` returns the native application (Express app, Fastify instance, Hono app);
- `adapter.server()` returns the Node.js HTTP server started by `listen()`;
- `ctx.raw` is the native request (or context), as an escape hatch in a route.

`app.close()` waits for the pending requests, closes the responses being streamed, then runs the `onClose` hooks of the plugins: call it on `SIGTERM` for a graceful shutdown (see [Node.js and containers](/deployment/node)).

## In tests

The memory adapter of `@dotpress/testing` is an adapter too: it runs the requests in memory, without a port. See [Testing](/routing/testing).
