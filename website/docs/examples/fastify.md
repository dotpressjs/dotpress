# Fastify

A small notes API, with its Dotpress routes mounted on an existing [Fastify](https://fastify.dev) instance, and served by Node.js or by AWS Lambda:

- Dotpress routes next to a native Fastify route (`/health`), with a Fastify hook applied to both;
- one app, two entries: `server.ts` for Node.js, `lambda.ts` for AWS Lambda;
- tests with `inject()` of Fastify, over HTTP, and on simulated API Gateway events, without an AWS account.

Source: [`examples/fastify`](https://github.com/dotpressjs/dotpress/tree/main/examples/fastify).

## Run it

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

## The routes

The routes receive their store as an argument, and know nothing about the server:

```ts file="<root>/../examples/fastify/src/routes.ts"
```

## The app

The Fastify instance keeps its own routes and hooks: `beforeRoutes` registers what must also apply to the Dotpress routes.

```ts file="<root>/../examples/fastify/src/app.ts"
```

## Two entries

On Node.js, the server closes gracefully on `SIGTERM`:

```ts file="<root>/../examples/fastify/src/server.ts"
```

On AWS Lambda, the same app, created at the first invocation:

```ts file="<root>/../examples/fastify/src/lambda.ts"
```

`npm run build:lambda` bundles the handler with esbuild into `dist/lambda.mjs`, about 300 kB gzipped with Fastify. Fastify is a CommonJS package: the script defines `require` for it. See [Bundle the handler](/adapters/aws-lambda#bundle-the-handler) and [Deployment › AWS Lambda](/deployment/aws-lambda).

## Learn more

- [The Fastify adapter](/adapters/fastify)
- [The AWS Lambda adapter](/adapters/aws-lambda)
- [Testing](/routing/testing)
