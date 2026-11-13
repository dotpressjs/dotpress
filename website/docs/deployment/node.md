# Node.js and containers

A Dotpress app on Node.js is a long-running process: a container, a VM, or a platform that runs one (Cloud Run, Fly.io, Railway, Render, Kubernetes…). This page covers what to set up before going to production.

## Run TypeScript

Node.js 22.18 or later runs TypeScript files directly: `node src/server.ts`, without a build step. The examples run this way in production too. Node.js only strips the types, so the code must use erasable syntax only, and relative imports end with `.ts` (see [Installation](/getting-started/installation#configure-typescript)).

You can also compile with `tsc` or a bundler, and run the JavaScript: Dotpress works the same.

## Configuration

Dotpress never reads environment variables: the configuration is yours. Read it once, at startup, and check it with Zod: a missing or invalid variable stops the process with an explicit message, instead of failing later on a request.

```ts file="<root>/../examples/tasks-api/src/config.ts"
```

Each process declares what it needs in production: the API needs the keys of the tokens, the worker does not.

```ts
const config = loadConfig()
requireInProduction(config, ['PUBLIC_URL', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY'])
```

Keep the secrets (keys, passwords, tokens) in the secret manager of your platform, given to the process as environment variables. Never in the image, never in the repository.

## Graceful shutdown

Platforms stop a container with `SIGTERM`, then kill it after a delay (10 seconds for Docker, 30 for Kubernetes). On `SIGTERM`, call `app.close()`: it stops accepting connections, waits for the pending requests, closes the streamed responses, then runs the `onClose` hooks of the plugins. Close your own connections afterwards.

```ts file="<root>/../examples/tasks-api/src/http/server.ts"
```

Without it, a deployment cuts the requests in progress.

## Health checks

Give the platform a route to check that the app is alive, and that it can reach its database:

```ts
const healthRouter = createRouter()

healthRouter.defineRoute({
  path: '/health',
  meta: { summary: 'Health check', tags: ['health'] },
  handler: ({ services }) => {
    services.db.prepare('SELECT 1').get()
    return { status: 'ok' }
  },
})
```

A failing check returns a `500`, and the platform stops sending traffic to the instance. Keep it cheap: it runs every few seconds.

## Behind a proxy

In production, a load balancer or a reverse proxy usually sits in front of the app, and terminates HTTPS:

- **Client IP addresses**: configure the server to trust the proxy headers, or every client shares the address of the proxy, including in the login throttling. See [Client IP address](/routing/http-options#client-ip-address-behind-a-proxy).
- **Sub-path**: when the app is served under a prefix (`/api`), use `basePath` or `publicBasePath`. See [Base path](/routing/http-options#base-path).
- **Request IDs**: to keep the ID set by the proxy, use `generateRequestId`. See [Request IDs](/routing/logging#request-ids).
- **Timeouts**: the proxy closes slow requests (often after 60 seconds), and idle connections. Server-Sent Events send a heartbeat every 15 seconds to stay open.

## Logs

Write the logs to the standard output, as JSON, and let the platform collect them. [Pino](https://getpino.io) does it, and works as is with Dotpress:

```ts
import pino from 'pino'

const app = await createApp({ adapter, logger: pino() })
```

Each line of a request carries its `requestId`, also sent to the client in `X-Request-ID`. See [Logging](/routing/logging).

## Several instances

With several instances behind a load balancer, keep every state in shared services:

| State | In memory, per instance | Shared |
| --- | --- | --- |
| Sessions | — | the refresh tokens, in your database |
| Login throttling | the default store | a [shared store](/auth/passwords#a-shared-store) (Redis, Postgres) |
| Cache | `createMemoryStore()` | `createRedisStore()`: an invalidation must reach every instance |
| Event queue | `createMemoryTransport()` | BullMQ, SQS, pg-boss… |
| Revoked sessions | — | `isSessionRevoked`, on the database or Redis |

## Containers

A Dockerfile for an app that runs its TypeScript sources:

```dockerfile title="Dockerfile"
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

# Dependencies first: this layer is rebuilt only when they change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
EXPOSE 3000
CMD ["node", "src/server.ts"]
```

```text title=".dockerignore"
node_modules
.env*
test
*.log
```

- **`npm ci`** installs the exact versions of the lockfile; `--omit=dev` leaves the test tools out.
- **`USER node`**: the process does not run as root.
- **`CMD ["node", …]`** in the exec form: Node.js receives `SIGTERM` directly, and the app closes gracefully. Run `node` rather than `npm start`: one process less between the platform and your app.
- Pick the current LTS release of Node.js for the image.

An [event worker](./event-workers) can use the same image, with another command: `CMD ["node_modules/.bin/dotpress-events", "work", "src/worker.ts"]`.

## Before going to production

- [ ] The configuration is checked at startup, and the secrets come from a secret manager.
- [ ] `SIGTERM` closes the app gracefully.
- [ ] A health check route is configured on the platform.
- [ ] The server trusts the proxy headers, and only those of your proxy.
- [ ] Logs are JSON, on the standard output.
- [ ] State is shared between the instances.
- [ ] `exposeErrors` is disabled, and unexpected errors are reported with `onError`.
- [ ] The [security checklist](/auth/security) of the authentication is done.
