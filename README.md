# Dotpress

A lightweight, decorator-free TypeScript framework for building end-to-end typed backend APIs.

> 🚧 This monorepo is being migrated to Dotpress V2.

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

## Development

Requirements: Node ≥ 22.18, pnpm 12 (the packages themselves run on Node.js 22.12 or later).

```sh
pnpm install
pnpm build       # required before testing: packages consume each other's builds
pnpm test
pnpm lint
pnpm typecheck
pnpm check:core  # core, openapi and the main entry of adapter-hono must stay runtime-agnostic
pnpm check:packages  # manifests, publint and Are the Types Wrong? (after the build)
pnpm test:packed     # installs the packed packages in a new project, and checks them as a consumer
```

Integration tests of the event transports and the cache stores run when their services are available, and are skipped otherwise ([serverless-redis-http](https://github.com/hiett/serverless-redis-http) serves the Upstash REST API in front of Redis):

```sh
docker run -d --rm -p 6379:6379 redis:7-alpine
docker run -d --rm -p 6380:6379 valkey/valkey:8-alpine
docker run -d --rm -p 8079:80 -e SRH_MODE=env -e SRH_TOKEN=test-token -e SRH_CONNECTION_STRING=redis://host.docker.internal:6379 hiett/serverless-redis-http:latest
docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=events postgres:18-alpine
REDIS_URL=redis://localhost:6379 VALKEY_URL=redis://localhost:6380 UPSTASH_URL=http://localhost:8079 UPSTASH_TOKEN=test-token \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/events pnpm test
```

The Google Pub/Sub tests also run against its emulator (a large image, not run by the CI); push deliveries reach the test server through `host.docker.internal` (set `PUBSUB_PUSH_HOST` otherwise):

```sh
docker run -d --rm -p 8085:8085 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
  gcloud beta emulators pubsub start --host-port=0.0.0.0:8085 --project=test-project
PUBSUB_EMULATOR_HOST=localhost:8085 pnpm test
```

The Azure Service Bus tests run against its emulator, with the queues of `packages/events/test/fixtures/azure-service-bus-emulator.json` (the emulator needs a SQL container; not run by the CI):

```sh
docker network create service-bus
docker run -d --rm --name sqledge --network service-bus -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Dotpress-Test-1' mcr.microsoft.com/azure-sql-edge:latest
docker run -d --rm --network service-bus -p 5672:5672 -p 5300:5300 \
  -v "$PWD/packages/events/test/fixtures/azure-service-bus-emulator.json:/ServiceBus_Emulator/ConfigFiles/Config.json" \
  -e SQL_SERVER=sqledge -e MSSQL_SA_PASSWORD='Dotpress-Test-1' -e ACCEPT_EULA=Y \
  mcr.microsoft.com/azure-messaging/servicebus-emulator:latest
SERVICE_BUS_CONNECTION='Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;' pnpm test
```

Every publishable change must come with a changeset (`pnpm changeset`).

## License

MIT
