# Hono

The same notes API on [Hono](https://hono.dev): one app, served by Node.js or by AWS Lambda.

- native Hono middlewares (`secureHeaders()`) applied to the Dotpress routes, and a native Hono route (`/health`);
- two entries: `node.ts` with `@hono/node-server`, `lambda.ts` with the main entry of the adapter, which has no Node.js server;
- tests in memory with `adapter.fetch()` (Web `Request` and `Response`), over HTTP, and on simulated API Gateway events.

Source: [`examples/hono`](https://github.com/dotpressjs/dotpress/tree/main/examples/hono).

## Run it

```sh
npx degit dotpressjs/dotpress/examples/hono my-api
cd my-api
npm install
npm run dev
```

```sh
curl -X POST localhost:3000/notes -H 'content-type: application/json' -d '{"text":"Hello"}'
curl localhost:3000/notes
curl localhost:3000/health
```

## The routes

The same routes as the [Fastify example](./fastify), unchanged: they do not depend on the server.

```ts file="<root>/../examples/hono/src/routes.ts"
```

## The app

The app takes its adapter as a parameter: the options of the adapter are shared, the adapter itself comes from the entry.

```ts file="<root>/../examples/hono/src/app.ts"
```

## Two entries

```ts file="<root>/../examples/hono/src/node.ts"
```

```ts file="<root>/../examples/hono/src/lambda.ts"
```

`npm run build:lambda` bundles the handler into `dist/lambda.mjs`: about 115 kB gzipped, Hono and Zod included, the smallest of the adapters. See [Choosing an adapter](/adapters/).

## Learn more

- [The Hono adapter](/adapters/hono)
- [The AWS Lambda adapter](/adapters/aws-lambda)
- [Deployment › AWS Lambda](/deployment/aws-lambda)
