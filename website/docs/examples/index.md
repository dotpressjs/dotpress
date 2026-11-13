# Examples

Runnable apps, from one feature to a complete API. Each one is tested by the CI of the repository, and its code is imported in these pages when the site is built: what you read is what runs.

| Example | What it shows | Server |
| --- | --- | --- |
| [Express](./express) | Routes, validation, returned errors, OpenAPI and Scalar | Express |
| [Fastify](./fastify) | Dotpress routes on an existing Fastify instance, on Node.js and AWS Lambda | Fastify |
| [Hono](./hono) | One app on Node.js and AWS Lambda, with native Hono middlewares | Hono |
| [Authentication](./auth) | Sign-up, login, token rotation, cookie sessions, roles, logout | Express |
| [Events](./events) | Events emitted by an API, listeners run by a worker through Redis | Fastify |
| [Mailer](./mailer) | A contact form sending multilingual MJML emails, with previews and SMTP | Hono |
| [Cache](./cache) | Memo and batching per request, cache with tags and grace period, Redis | Express |
| [Tasks API](./tasks-api) | A team task manager: every package in one app, organized by feature | Fastify |

Start with the example of your server, then the one of the feature you need. The [Tasks API](./tasks-api) shows how they fit together in a real project.

## Run an example

Every example requires Node.js 22.18 or later, which runs the TypeScript sources directly. Copy it with [degit](https://github.com/Rich-Harris/degit), then install it with your package manager:

```sh
npx degit dotpressjs/dotpress/examples/express my-api
cd my-api
npm install
npm run dev
```

In every example, `npm test` runs the tests and `npm run typecheck` checks the types. The examples that use Redis or an SMTP server work without them: their `compose.yaml` starts them for development.
