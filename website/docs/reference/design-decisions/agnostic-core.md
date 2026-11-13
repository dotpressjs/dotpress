# A transport-agnostic core

## Context

Express, Fastify and Hono serve HTTP very well. What an API needs on top of them is the same everywhere: typed routes, validation, one error format, middlewares, plugins. Yet each server has its own request object, its own middleware model, its own error handling. An app written for one ends up coupled to it, and changing the server, or running the same API on AWS Lambda, means rewriting its HTTP layer.

## Decision

- **`@dotpress/core` imports no HTTP server.** It works on a normalized request and returns a normalized response, made of Web standards only: `Uint8Array`, `ReadableStream`, `File`, `AbortSignal`, `crypto.randomUUID()`.
- **Adapters translate.** An adapter converts the native request of its server into the normalized request, runs the pipeline of the route, and writes the normalized response. Express, Fastify, Hono and AWS Lambda each have one.
- **`ctx.req` and `ctx.res` are the same on every adapter.** The native request stays available as `ctx.raw`, as an escape hatch.
- **Every adapter behaves the same**: route matching, body parsing and limits, `HEAD` requests, errors, streaming. A shared [conformance suite](/services/testing#writing-an-adapter) runs against each of them.
- **The rule is checked in CI**: an ESLint rule forbids imports of HTTP servers and of Node.js modules (`node:*`, `Buffer`, `process`…) in the core and the service packages. Node.js-only code lives in adapters, and in separate entry points (the SMTP provider, the CLIs).
- **The core reads no environment variable**: the configuration is passed to `createApp()` and to the services.

## Alternatives considered

- **Building on one server**: Express, Fastify or Hono. Simpler, but every app and plugin would be coupled to it, and no server is the best choice everywhere: on AWS Lambda, for instance.
- **Exposing the native objects in the context.** Convenient, but every handler and plugin using them would depend on one server again. `ctx.raw` keeps the door open, explicitly.

## Consequences

- The routes, middlewares and plugins of an app run unchanged on Express, Fastify, Hono and AWS Lambda: the server becomes a deployment choice. See [Choosing an adapter](/adapters/).
- Plugins are written once, for every adapter.
- Handlers return their response instead of writing it: the same code produces the same response everywhere, and tests run without a server.
- Native middlewares of a server still work, registered on the adapter (`beforeRoutes`), but they tie that part of the app to it.
- Features specific to one server (Fastify schemas, Hono's typed client) are not used by Dotpress routes.
- Writing an adapter is a contained task: the `HttpAdapter` contract and the conformance suite define it.

See [How Dotpress works](/concepts/how-it-works) and [Adapters](/adapters/).
