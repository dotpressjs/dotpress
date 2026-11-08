# Dotpress

A lightweight, decorator-free TypeScript framework for building end-to-end typed backend APIs.

> 🚧 This monorepo is being migrated to Dotpress V2.

## Packages

| Package | Description | Version |
|---|---|---|
| [`@dotpress/core`](packages/core) | Server-agnostic core: routing, validation, pipeline, responses | 2.0 alpha |
| [`@dotpress/adapter-express`](packages/adapter-express) | Express 4 and 5 adapter | 2.0 alpha |
| [`@dotpress/adapter-hono`](packages/adapter-hono) | Hono 4 adapter, on Node.js and AWS Lambda | 2.0 alpha |
| [`@dotpress/testing`](packages/testing) | Testing helpers and adapter conformance suite | 2.0 alpha |
| [`@dotpress/auth`](packages/auth) | JWT authentication plugin | 2.0 alpha |
| [`@dotpress/openapi`](packages/openapi) | OpenAPI 3.1 documents and Scalar API reference | 2.0 alpha |

The V1 framework (`dotpress` on npm) is frozen in 1.x.

## Development

Requirements: Node ≥ 22.18, pnpm 12.

```sh
pnpm install
pnpm build       # required before testing: packages consume each other's builds
pnpm test
pnpm lint
pnpm typecheck
pnpm check:core  # core, openapi and the main entry of adapter-hono must stay runtime-agnostic
```

Every publishable change must come with a changeset (`pnpm changeset`).

## License

MIT
