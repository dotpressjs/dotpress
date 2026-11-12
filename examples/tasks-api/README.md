# Tasks API

A team task manager built with [Dotpress](https://dotpress.dev): the packages assembled in one app, as in a real project. It runs on [Fastify](https://fastify.dev) and [SQLite](https://nodejs.org/api/sqlite.html).

| Package | Role in the app |
| --- | --- |
| `@dotpress/core` | Routes and nested route groups, validation with Zod, errors returned by the handlers |
| `@dotpress/adapter-fastify` | The HTTP server |
| `@dotpress/auth` | Sign-up, login, access and refresh tokens, `ctx.user` |
| `@dotpress/cache` | The membership checked once per request, assignees loaded in batches, the dashboard cached |
| `@dotpress/openapi` | The OpenAPI document and the Scalar page, with the secured routes |

## The story of the demo

1. **Alice and Bob sign up.** Bob's browser speaks French: his account is in French (`Accept-Language`).
2. **Alice creates the "Website launch" project, and adds Bob.** Only the owner adds members.
3. **Alice creates a task, and assigns it to Bob.** The assignee must be a member of the project.
4. **Bob lists his tasks** (`?assignee=`), with the name of each assignee: the names of a whole list are loaded with one query.
5. **Bob completes the task.**
6. **Alice opens the dashboard** of the project: tasks by status and by assignee. It is cached for 5 minutes, and expired at once when a task changes (cache tags).

Eve, who is not a member, gets `404` on every route of the project: its existence is not revealed. `test/scenario.test.ts` runs this story.

## Routes

Route groups share a path prefix and middlewares; a nested group inherits both, and its path parameters are typed in its routes:

```
POST /users                         sign up (public)
/auth/login, /refresh, /me, /logout the auth plugin

/projects                           group: requireAuth
  POST /  GET /                     create, list my projects
  /:projectId                       nested group: + requireMember (404 for non-members)
    GET /                           the project and its members
    POST /members                   add a member (owner only)
    GET /stats                      the dashboard (cached)

/projects/:projectId/tasks          group: requireAuth, requireMember
  POST /  GET /                     create, list (?status=, ?assignee=)

/tasks                              group: requireAuth
  GET /:id  PATCH /:id              the membership is checked once the task is loaded
```

`requireMember` (`src/loaders.ts`) checks the membership once for every route of the group, and memoizes the role: a handler that reads it again, to check the owner for instance, makes no other query.

## Run it

Requires Node.js 22.18 or later: Node.js runs the TypeScript sources directly.

```sh
npx degit dotpressjs/dotpress/examples/tasks-api my-api
cd my-api
npm install
npm run seed # Alice, Bob and the "Website launch" project
npm run dev
```

Open `http://localhost:3000/docs`: log in with `POST /auth/login` (`alice@example.com` or `bob@example.com`, password `correct horse battery staple`), then paste the access token in the Authorize dialog.

The same story with curl:

```sh
API=http://localhost:3000
login() { curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d "{\"username\":\"$1\",\"password\":\"correct horse battery staple\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken'; }
ALICE=$(login alice@example.com)
BOB=$(login bob@example.com)

PROJECT=$(curl -s $API/projects -H "authorization: Bearer $ALICE" | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')
BOB_ID=$(curl -s $API/auth/me -H "authorization: Bearer $BOB" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

TASK=$(curl -s -X POST $API/projects/$PROJECT/tasks -H "authorization: Bearer $ALICE" \
  -H 'content-type: application/json' -d "{\"title\":\"Translate the homepage\",\"assigneeId\":\"$BOB_ID\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s "$API/projects/$PROJECT/tasks?assignee=$BOB_ID" -H "authorization: Bearer $BOB"
curl -s -X PATCH $API/tasks/$TASK -H "authorization: Bearer $BOB" \
  -H 'content-type: application/json' -d '{"status":"done"}'
curl -s $API/projects/$PROJECT/stats -H "authorization: Bearer $ALICE"
```

`npm test` runs the tests, `npm run typecheck` checks the types. With `REDIS_URL`, the cache tests also run on Redis.

## Why SQLite

The data lives in a SQLite file (`data/tasks.db`), through `node:sqlite`, built into Node.js:

- **nothing to install**: no database server, no dependency, and each test gets its own database in memory (`:memory:`);
- **real SQL**: tables, foreign keys, indexes, transactions, like the database of a real app;
- **one file for several processes**: the API and other processes (a worker, `npm run seed`) open the same database, which an in-memory store would not allow.

`node:sqlite` is still experimental in Node.js 22, which prints an `ExperimentalWarning` once; Node.js 24 and later do not. For production with several instances, use a database server: the repositories (`src/*/repository.ts`) are asynchronous, so replacing SQLite with Postgres changes their queries, not their callers. The schema (`src/db/schema.sql`) is applied at startup; a real app would use migrations.

## Configuration

Read and checked at startup by `src/config.ts`: an invalid variable stops the process with an explicit message.

| Variable | Content |
| --- | --- |
| `DATABASE_PATH` | SQLite file, created when missing. Defaults to `data/tasks.db` |
| `PUBLIC_URL` | Public URL of the API, written in the tokens. Defaults to `http://localhost:<PORT>`; required in production |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | RSA key pair (PEM). In development, a pair is generated once in `data/dev-keys.json`; required in production |
| `REDIS_URL` | Redis, for a cache shared by every instance. Without it, the cache lives in memory |
| `PORT` | Defaults to `3000` |
| `NODE_ENV` | `development` (default), `test` or `production` |

`data/` holds the database and the development keys: it is ignored by git.

## Files

| File | Content |
| --- | --- |
| `src/config.ts` | The settings, from the environment, validated by Zod |
| `src/db/` | The SQLite connection and the schema |
| `src/users/` | Accounts: sign-up, language of the user |
| `src/auth/` | The authentication service, its data provider on SQLite, the keys |
| `src/projects/` | Projects, members, and the cached dashboard (`stats.ts`), in nested route groups |
| `src/tasks/` | Tasks: creation, list with filters, updates |
| `src/loaders.ts` | Values loaded once per request (memo): roles and users; the `requireMember` middleware |
| `src/cache-store.ts` | The cache store: Redis or memory |
| `src/app.ts` | The app: routers and plugins |
| `src/server.ts` | The Fastify server |
| `src/seed.ts`, `src/demo-data.ts` | The demo data (`npm run seed`) |
| `test/scenario.test.ts` | The story of the demo |
| `test/access.test.ts` | Who may do what |
| `test/tasks.test.ts` | Filters, validation, queries counted for the memo (middleware and handler included) |
| `test/stats.test.ts` | The cached dashboard, on memory and on Redis |
| `test/app.test.ts` | Health check, OpenAPI, configuration, keys, demo data |
| `test/server.test.ts` | The demo data over HTTP, on Fastify |

Each feature has its own example, closer to the details: `auth` (cookies, rotation, logout), `cache` (grace period, invalidation) and `express` (OpenAPI).
