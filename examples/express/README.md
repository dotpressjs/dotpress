# Dotpress on Express

A small tasks API on [Express](https://expressjs.com), with [Dotpress](https://dotpress.dev):

- typed routes in a group (`/tasks`), with parameters, query and body validated by Zod schemas;
- errors returned by the handlers (`notFoundError()`, `conflictError()`), typed and documented;
- an OpenAPI 3.1 document generated from the routes (`/openapi.json`), and its Scalar API reference (`/docs`);
- tests of the app in memory with `@dotpress/testing`, and on the real Express server.

## Run it

Requires Node.js 22.18 or later: Node.js runs the TypeScript sources directly.

```sh
npx degit dotpressjs/dotpress/examples/express my-api
cd my-api
npm install
npm run dev
```

Then open the API reference at <http://localhost:3000/docs>, or try the API:

```sh
curl -X POST localhost:3000/tasks -H 'content-type: application/json' -d '{"title":"Try Dotpress"}'
curl localhost:3000/tasks
curl localhost:3000/tasks?done=false
```

`PORT` changes the port. `npm test` runs the tests, `npm run typecheck` checks the types.

## Files

| File | Content |
| --- | --- |
| `src/routes.ts` | The routes, with their schemas and documentation |
| `src/tasks.ts` | An in-memory store, to replace with your database |
| `src/app.ts` | The app, on any adapter: plugins and routers |
| `src/server.ts` | The Express server, and its graceful shutdown |
| `test/tasks.test.ts` | Tests of the API in memory (memory adapter) |
| `test/server.test.ts` | Tests over HTTP, on the Express server |
