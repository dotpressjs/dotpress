# Express

A small tasks API on [Express](https://expressjs.com):

- typed routes in a group (`/tasks`), with parameters, query and body validated by Zod schemas;
- errors returned by the handlers (`notFoundError()`, `conflictError()`), typed and documented;
- an OpenAPI 3.1 document generated from the routes (`/openapi.json`), and its Scalar API reference (`/docs`);
- tests of the app in memory with `@dotpress/testing`, and on the real Express server.

The code below is the code of the example, imported when the site is built.

## Run it

Requires Node.js 22.18 or later: Node.js runs the TypeScript sources directly.

```sh
npx degit dotpressjs/dotpress/examples/express my-api
cd my-api
npm install
npm run dev
```

## The routes

```ts file="<root>/../examples/express/src/routes.ts"
```

## The app

The app takes its adapter as a parameter: Express in `server.ts`, the memory adapter of `@dotpress/testing` in the tests.

```ts file="<root>/../examples/express/src/app.ts"
```

## The server

```ts file="<root>/../examples/express/src/server.ts"
```
