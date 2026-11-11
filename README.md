# Dotpress

A lightweight, decorator-free TypeScript framework for building end-to-end typed backend APIs.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0. Install the packages without tag, except `@dotpress/auth@alpha` (without tag, `@dotpress/auth` is the 1.x).

## Packages

| Package | Description | Version |
|---|---|---|
| [`@dotpress/core`](packages/core) | Server-agnostic core: routing, validation, pipeline, responses | 2.0 alpha |
| [`@dotpress/adapter-express`](packages/adapter-express) | Express 4 and 5 adapter | 2.0 alpha |
| [`@dotpress/adapter-hono`](packages/adapter-hono) | Hono 4 adapter, on Node.js and AWS Lambda | 2.0 alpha |
| [`@dotpress/adapter-fastify`](packages/adapter-fastify) | Fastify 5 adapter, on Node.js and AWS Lambda | 2.0 alpha |
| [`@dotpress/testing`](packages/testing) | Testing helpers and adapter conformance suite | 2.0 alpha |
| [`@dotpress/auth`](packages/auth) | JWT authentication plugin | 2.0 alpha |
| [`@dotpress/openapi`](packages/openapi) | OpenAPI 3.1 documents and Scalar API reference | 2.0 alpha |
| [`@dotpress/mailer`](packages/mailer) | Typed, multilingual email templates (MJML or HTML) | 2.0 alpha |
| [`@dotpress/events`](packages/events) | Typed events and listeners, run by workers through interchangeable transports | 2.0 alpha |
| [`@dotpress/cache`](packages/cache) | Request memoization with batching, and a resilient cache with interchangeable stores | 2.0 alpha |

The V1 framework (`dotpress` on npm) is frozen in 1.x.

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the checks and the changesets, and the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as described in the [security policy](SECURITY.md).

## License

MIT
