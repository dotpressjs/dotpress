# Dotpress on Fastify

A small notes API with [Dotpress](https://dotpress.dev), mounted on an existing [Fastify](https://fastify.dev) instance, served by Node.js or by AWS Lambda:

- Dotpress routes next to native Fastify routes (`/health`), with the Fastify hooks applied to both (`x-request-id` header);
- one app, two entries: `src/server.ts` for Node.js, `src/lambda.ts` for AWS Lambda (API Gateway REST and HTTP APIs, Function URLs, Application Load Balancers);
- tests with `inject()` of Fastify, over HTTP, and on simulated API Gateway events (`@dotpress/testing`), without an AWS account.

## Run it

Requires Node.js 22.18 or later: Node.js runs the TypeScript sources directly.

```sh
npx degit dotpressjs/dotpress/examples/fastify my-api
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

`npm run build:lambda` bundles the handler with esbuild into `dist/lambda.mjs` (about 1.1 MB minified, 300 kB gzipped, Fastify included). Deploy it with your tool (AWS SAM, CDK, Serverless Framework, Terraform…):

- runtime: Node.js 22 or later;
- handler: `lambda.handler`;
- trigger: an API Gateway HTTP API, a REST API, a Function URL or an Application Load Balancer.

Fastify and its dependencies are CommonJS modules: the bundle defines `require` for them (`--banner` option of the script).

The notes are kept in memory: each execution environment of the function has its own. Replace `src/notes.ts` with your database.

## Files

| File | Content |
| --- | --- |
| `src/routes.ts` | The Dotpress routes, independent of the server |
| `src/notes.ts` | An in-memory store, to replace with your database |
| `src/app.ts` | The Fastify instance, its native routes and hooks, and the app |
| `src/server.ts` | The Node.js server |
| `src/lambda.ts` | The AWS Lambda handler |
| `test/app.test.ts` | Tests with `inject()`, without opening a port |
| `test/server.test.ts` | Tests over HTTP |
| `test/lambda.test.ts` | Tests on simulated API Gateway events (payloads v1 and v2), and of the bundle |
