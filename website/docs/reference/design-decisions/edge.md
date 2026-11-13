# No edge runtime in 2.0

## Context

Edge runtimes (Cloudflare Workers, Deno Deploy, Vercel Edge…) run JavaScript close to the users, on Web-standard APIs. Bun and Deno also run servers, with their own APIs.

Supporting a runtime is more than code that happens to run on it. Each one has its own limits (CPU time per request, memory, bundle size, available Node.js APIs), its own way to deploy, and its own behavior for streaming, disconnections and background work. Supporting it means running the test suite on it in CI, documenting how to deploy, and answering the issues it raises.

## Decision

- **Dotpress 2.0 supports Node.js and AWS Lambda.** CI runs every package on Node.js 22, 24 and 26, and the conformance suite on every adapter, including the three Lambda triggers. Both have deployment guides.
- **The core stays portable.** `@dotpress/core` and the service packages only use Web-standard APIs, checked by an ESLint rule (see [A transport-agnostic core](./agnostic-core)). The main entry of `@dotpress/adapter-hono` only relies on Hono and Web standards, and `adapter.fetch` handles a Web `Request`.
- **Other runtimes are not officially supported yet**: they may work, but are not tested.

## Alternatives considered

- **Supporting edge runtimes in 2.0.** It would have spread the testing and the documentation over several runtimes before the API is stable, while many APIs need what edge runtimes limit: database connections, long requests, Node.js libraries.
- **Ignoring edge runtimes.** Using Node.js APIs freely in the core would have made adding them later a rewrite.

## Consequences

- An API deployed on Node.js or AWS Lambda is on the supported path, with its deployment guides.
- Running on Bun, Deno or an edge runtime is possible through `adapter.fetch` of the Hono adapter, at your own risk: report what you find in an issue.
- Some providers already talk to edge services over HTTP: the Upstash and Workers KV stores of the cache, Cloudflare Queues for events.
- Adding a runtime later is an addition, not a rewrite: an entry point for the adapter, the conformance suite in CI, and a deployment guide.

See [Hono › Other runtimes](/adapters/hono#other-runtimes).
