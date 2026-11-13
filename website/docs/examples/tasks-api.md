# Tasks API

A team task manager: every package of Dotpress assembled in one app, organized as a real project. It runs on Fastify and [SQLite](https://nodejs.org/api/sqlite.html), built into Node.js.

| Package | Role in the app |
| --- | --- |
| `@dotpress/core` | Routes and nested route groups, validation, errors returned by the handlers |
| `@dotpress/adapter-fastify` | The HTTP server |
| `@dotpress/auth` | Sign-up, login, access and refresh tokens, `ctx.user` |
| `@dotpress/cache` | The membership checked once per request, assignees loaded in batches, the dashboard cached |
| `@dotpress/events` | `task.assigned` and `task.completed`, handled by listeners in a worker, through Redis |
| `@dotpress/mailer` | The notification emails, in MJML, in the language of each recipient |
| `@dotpress/openapi` | The OpenAPI document and the Scalar page, with the secured routes |

Source: [`examples/tasks-api`](https://github.com/dotpressjs/dotpress/tree/main/examples/tasks-api).

## The story

1. **Alice and Bob sign up.** Bob's browser speaks French: his account is in French.
2. **Alice creates the "Website launch" project, and adds Bob.** Only the owner adds members.
3. **Alice creates a task, and assigns it to Bob.** The assignee must be a member of the project. The route emits `task.assigned` and answers at once: a listener, in the worker, emails Bob in French.
4. **Bob lists his tasks**, with the name of each assignee: the names of a whole list are loaded with one query.
5. **Bob completes the task.** The route emits `task.completed`: Alice, who created the task, gets an email in English.
6. **Alice opens the dashboard** of the project. It is cached for 5 minutes, and expired at once when a task changes.

Eve, who is not a member, gets `404` on every route of the project: its existence is not revealed. `test/scenario.test.ts` runs this story.

## Run it

```sh
npx degit dotpressjs/dotpress/examples/tasks-api my-api
cd my-api
npm install
npm run seed # Alice, Bob and the "Website launch" project
npm run dev
```

Open `http://localhost:3000/docs`, log in with `POST /auth/login` (`alice@example.com` or `bob@example.com`, password `correct horse battery staple`), then paste the access token in the Authorize dialog.

Without Redis, the listeners run in the API process, and the emails are printed in its terminal.

### With Redis and Mailpit

The production setup: the API queues the events in Redis, a worker runs the listeners, and the emails go over SMTP to [Mailpit](https://mailpit.axllent.org), at `http://localhost:8025`.

```sh
docker compose up -d # Redis and Mailpit
export REDIS_URL=redis://localhost:6379 SMTP_URL=smtp://localhost:1025
npm run dev # terminal 1: the API
npm run worker # terminal 2: the worker
```

## The routes

```text
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

## Project structure

The code is organized by feature: each folder holds the routes, the data access, the events and the emails of its feature. See [Project structure](/getting-started/project-structure).

```text
src/
  config.ts                 the settings, from the environment, validated by Zod
  services/                 the services, created by functions (not singletons)
  http/
    server.ts               entry point of the API: config → services → app → listen
    app.ts                  the app: plugins and routers
    routes.ts               the routers of the features, and the health check
    services-plugin.ts      ctx.services, typed in every handler
  worker.ts                 entry point of the worker (dotpress-events work)
  db/                       the SQLite connection and the schema
  features/
    auth/                   the authentication service, its data provider, the keys
    users/                  sign-up, language of the user, the memo of the users
    projects/               projects, members, access rules, the cached dashboard
    tasks/                  tasks, their routes and their events
    notifications/          the listeners of the task events, and their emails
```

## The app

Each entry point creates its services once, and gives them to the app: the API in `server.ts`, each test its own, in memory.

```ts file="<root>/../examples/tasks-api/src/http/app.ts"
```

The handlers find the services in `ctx.services`, typed by module augmentation: the route files stay plain modules, without singletons to import.

```ts file="<root>/../examples/tasks-api/src/http/services-plugin.ts"
```

## Access rules

`requireMember` checks the membership once for every route of a project, and memoizes the role: a handler that reads it again, to check the owner, makes no other query.

```ts file="<root>/../examples/tasks-api/src/features/projects/access.ts"
```

## The task routes

Nested groups, typed path parameters, returned errors, and events emitted after the changes are stored:

```ts file="<root>/../examples/tasks-api/src/features/tasks/routes.ts"
```

## Notifications

Events carry identifiers, not data: the listeners load what they need, ignore messages already handled or outdated, and throw to be retried.

```ts file="<root>/../examples/tasks-api/src/features/notifications/listeners.ts"
```

```ts file="<root>/../examples/tasks-api/src/worker.ts"
```

## Why SQLite

`node:sqlite` needs nothing to install, runs real SQL (tables, foreign keys, transactions), gives each test its own database in memory, and lets the API, the worker and the seed script open the same file. For production with several instances, use a database server: the repositories are asynchronous, so replacing SQLite with Postgres changes their queries, not their callers.

`node:sqlite` is still experimental in Node.js 22, which prints an `ExperimentalWarning` once; Node.js 24 and later do not.

## Learn more

- [Configuration and graceful shutdown](/deployment/node), with the `config.ts` and `server.ts` of this example
- [An SQL data provider](/auth/data-provider#an-sql-data-provider), from this example
- The examples of each feature, closer to the details: [Authentication](./auth), [Events](./events), [Mailer](./mailer), [Cache](./cache)
