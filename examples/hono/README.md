# Dotpress on Hono

A small notes API with [Dotpress](https://dotpress.dev) on [Hono](https://hono.dev): one app, served by Node.js or by AWS Lambda.

- Native Hono middlewares (`secureHeaders()`) applied to the Dotpress routes, and a native Hono route (`/health`);
- two entries: `src/node.ts` for Node.js (`@hono/node-server`), `src/lambda.ts` for AWS Lambda (API Gateway REST and HTTP APIs, Function URLs, Application Load Balancers);
- tests in memory with `adapter.fetch()` (Web `Request` and `Response`), over HTTP, and on simulated API Gateway events (`@dotpress/testing`), without an AWS account.

## Run it

Requires Node.js 22.18 or later: Node.js runs the TypeScript sources directly.

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

`PORT` changes the port. `npm test` runs the tests, `npm run typecheck` checks the types.

## Deploy to AWS Lambda

`npm run build:lambda` bundles the handler with esbuild into `dist/lambda.mjs` (about 510 kB minified, 115 kB gzipped, Hono and Zod included). The Lambda entry uses the main entry of the adapter, without Node.js server. Deploy it with your tool (AWS SAM, CDK, Serverless Framework, Terraform…):

- runtime: Node.js 22 or later;
- handler: `lambda.handler`;
- trigger: an API Gateway HTTP API, a REST API, a Function URL or an Application Load Balancer.

The notes are kept in memory: each execution environment of the function has its own. Replace `src/notes.ts` with your database.

## Files

| File | Content |
| --- | --- |
| `src/routes.ts` | The Dotpress routes, independent of the server |
| `src/notes.ts` | An in-memory store, to replace with your database |
| `src/app.ts` | The options of the Hono adapter (native middlewares and routes), and the app |
| `src/node.ts` | The Node.js server |
| `src/lambda.ts` | The AWS Lambda handler |
| `test/app.test.ts` | Tests in memory, with `adapter.fetch()` |
| `test/server.test.ts` | Tests over HTTP |
| `test/lambda.test.ts` | Tests on simulated API Gateway events (payloads v1 and v2), and of the bundle |
