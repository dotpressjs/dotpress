# Dotpress

A lightweight, decorator-free TypeScript framework for building end-to-end typed backend APIs.

> 🚧 This monorepo is being migrated to Dotpress V2.

## Packages

| Package | Description | Version |
|---|---|---|
| [`dotpress`](packages/dotpress) | V1 framework (Express 4), future compatibility meta-package | 1.x |
| [`@dotpress/auth`](packages/auth) | JWT authentication plugin | 1.x |

## Development

Requirements: Node ≥ 22.18, pnpm 12.

```sh
pnpm install
pnpm build       # required before testing: @dotpress/auth consumes the dotpress build
pnpm test
pnpm lint
pnpm typecheck
```

Every publishable change must come with a changeset (`pnpm changeset`).

## License

MIT
