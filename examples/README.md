# Examples

Runnable examples of [Dotpress](https://dotpress.dev), tested by the CI of this repository.

| Example | Content |
| --- | --- |
| [`express`](express) | Routes, validation, returned errors, OpenAPI and Scalar, on Express |
| [`fastify`](fastify) | Dotpress routes on an existing Fastify instance, on Node.js and AWS Lambda |
| [`hono`](hono) | One app on Hono, on Node.js and AWS Lambda |
| [`auth`](auth) | Sign-up, login, token rotation, cookie sessions, roles and logout, on Express |
| [`events`](events) | Events emitted by an API, and listeners run by a worker through Redis (BullMQ), on Fastify |
| [`mailer`](mailer) | A contact form sending multilingual MJML emails, with previews and SMTP, on Hono |

Copy an example with [degit](https://github.com/Rich-Harris/degit), then install it with your package manager:

```sh
npx degit dotpressjs/dotpress/examples/express my-api
```

## In this repository

Examples are private packages of the workspace. They declare the current version of the `@dotpress/*` packages, and pnpm links them to the sources of the repository (`linkWorkspacePackages`): an example always runs the code of its commit. `pnpm check:examples` checks these links. `pnpm typecheck` and `pnpm test` include the examples.
