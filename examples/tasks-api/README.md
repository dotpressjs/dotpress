# Tasks API

A team task manager built with [Dotpress](https://dotpress.dev): the packages assembled in one app, as in a real project. It runs on [Fastify](https://fastify.dev) and [SQLite](https://nodejs.org/api/sqlite.html).

| Package | Role in the app |
| --- | --- |
| `@dotpress/core` | Routes and nested route groups, validation with Zod, errors returned by the handlers |
| `@dotpress/adapter-fastify` | The HTTP server |
| `@dotpress/auth` | Sign-up, login, access and refresh tokens, `ctx.user` |
| `@dotpress/cache` | The membership checked once per request, assignees loaded in batches, the dashboard cached |
| `@dotpress/events` | `task.assigned` and `task.completed`, handled by listeners in a worker, through Redis (BullMQ) |
| `@dotpress/mailer` | The notification emails, in MJML, in the language of each recipient |
| `@dotpress/openapi` | The OpenAPI document and the Scalar page, with the secured routes |

## The story of the demo

1. **Alice and Bob sign up.** Bob's browser speaks French: his account is in French (`Accept-Language`).
2. **Alice creates the "Website launch" project, and adds Bob.** Only the owner adds members.
3. **Alice creates a task, and assigns it to Bob.** The assignee must be a member of the project. The route emits `task.assigned` and answers at once: a listener, in the worker, emails Bob **in French**.
4. **Bob lists his tasks** (`?assignee=`), with the name of each assignee: the names of a whole list are loaded with one query.
5. **Bob completes the task.** The route emits `task.completed`: Alice, who created the task, gets an email **in English**.
6. **Alice opens the dashboard** of the project: tasks by status and by assignee. It is cached for 5 minutes, and expired at once when a task changes (cache tags).

Eve, who is not a member, gets `404` on every route of the project: its existence is not revealed. `test/scenario.test.ts` runs this story.

Nobody is told about what they did themselves: assigning a task to oneself, or completing one's own task, sends nothing.

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

`requireMember` (`src/features/projects/access.ts`) checks the membership once for every route of the group, and memoizes the role: a handler that reads it again, to check the owner for instance, makes no other query.

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

Without Redis, the listeners run in the API process, and the emails are printed in its terminal.

### With Redis and Mailpit

The production setup: the API queues the events in Redis, a worker runs the listeners, and the emails go over SMTP to [Mailpit](https://mailpit.axllent.org), which shows them at `http://localhost:8025`.

```sh
docker compose up -d # Redis and Mailpit, from compose.yaml
export REDIS_URL=redis://localhost:6379 SMTP_URL=smtp://localhost:1025
npm run dev # terminal 1: the API
npm run worker # terminal 2: the worker (same variables)
```

Stop the worker, assign a task, then start it again: the email is sent, as the message waited in the queue. `npm run worker` runs `dotpress-events work src/worker.ts --watch`; Ctrl+C stops it after the jobs in progress.

`npm test` runs the tests, `npm run typecheck` checks the types. With `REDIS_URL`, the tests also run the cache and the queue on Redis; with `SMTP_URL` and `MAILPIT_URL=http://localhost:8025`, they also send an email to Mailpit.

## Notifications

- **Events carry identifiers** (`taskId`, `assigneeId`), not data: queues store the messages, and the listeners load what they need from the database (`src/features/notifications/listeners.ts`).
- **The worker opens the same SQLite file** as the API: one more reason for SQLite (see below).
- **One email per message**: a queue delivers a message at least once, and may deliver it again after a timeout. The listeners record the messages they handled (`handled_messages` table), so a second delivery sends nothing.
- **Outdated messages are ignored**: a task reassigned or reopened before the worker handles the event sends nothing.
- **Failures are retried**: a listener that cannot send an email throws, and BullMQ retries it (3 attempts, exponential backoff), then keeps the job in its failed jobs.

## Why SQLite

The data lives in a SQLite file (`data/tasks.db`), through `node:sqlite`, built into Node.js:

- **nothing to install**: no database server, no dependency, and each test gets its own database in memory (`:memory:`);
- **real SQL**: tables, foreign keys, indexes, transactions, like the database of a real app;
- **one file for several processes**: the API, the worker and `npm run seed` open the same database. The listeners of the worker load the tasks and the users the API wrote, which an in-memory store would not allow.

`node:sqlite` is still experimental in Node.js 22, which prints an `ExperimentalWarning` once; Node.js 24 and later do not. For production with several instances, use a database server: the repositories (`src/features/*/repository.ts`) are asynchronous, so replacing SQLite with Postgres changes their queries, not their callers. The schema (`src/db/schema.sql`) is applied at startup; a real app would use migrations.

## Configuration

Read and checked at startup by `src/config.ts`: an invalid variable stops the process with an explicit message.

| Variable | Content |
| --- | --- |
| `DATABASE_PATH` | SQLite file, created when missing. Defaults to `data/tasks.db` |
| `PUBLIC_URL` | Public URL of the API, written in the tokens. Defaults to `http://localhost:<PORT>`; required in production |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | RSA key pair (PEM). In development, a pair is generated once in `data/dev-keys.json`; required in production |
| `REDIS_URL` | Redis: the queue of the events, and a cache shared by every instance. Without it, the listeners run in the API process, and the cache lives in memory |
| `EVENTS_QUEUE` | Name of the BullMQ queue. Defaults to `tasks-api-events` |
| `SMTP_URL` | SMTP server of the emails, `smtp://` or `smtps://`. Without it, the emails are printed |
| `MAIL_FROM` | Sender of the emails. Defaults to `Tasks <noreply@example.com>` |
| `PORT` | Defaults to `3000` |
| `NODE_ENV` | `development` (default), `test` or `production` |

In production, each process checks the variables it needs: the API requires `PUBLIC_URL` and the key pair (and `SMTP_URL` without Redis, as it sends the emails itself); the worker requires `REDIS_URL` and `SMTP_URL`.

`data/` holds the database and the development keys: it is ignored by git.

## Project structure

The code is organized by feature: everything a feature needs (routes, data access, events, emails) lives in its folder, next to a shared base. The [project structure guide](https://dotpress.dev/getting-started/project-structure) explains this layout.

```
src/
  config.ts                 the settings, from the environment, validated by Zod
  services/                 the services, created by functions (not singletons)
    index.ts                createRepositories(): repositories and memos over one database
    bus.ts                  the event transport (BullMQ or in-memory) and the event bus
    cache-store.ts          the cache store (Redis or memory)
    mailer.ts               the mail provider (SMTP or console) and the mailer
  http/
    server.ts               entry point of the API: config → services → app → listen
    app.ts                  the app: plugins and routers
    routes.ts               the routers of the features, and the health check
    services-plugin.ts      ctx.services, typed in every handler
  worker.ts                 entry point of the worker (dotpress-events work)
  seed.ts, demo-data.ts     entry point of npm run seed, and the demo data
  db/                       the SQLite connection and the schema
  mails/layout.ts           the layout shared by every email
  features/
    auth/                   the authentication service, its data provider, the keys
    users/                  sign-up, language of the user, the memo of the users
    projects/               projects, members, access rules (access.ts), the cached dashboard
    tasks/                  tasks, their routes and their events
    notifications/          the listeners of the task events, and their emails
test/                       one file per behavior: the story, access, tasks, cache, notifications…
```

**Services are created by each entry point, once.** The API, the worker and the seed script create the services they need (the worker needs no HTTP server, no cache, no key pair), and close them on shutdown. The tests create their own, in memory: an empty SQLite database, an in-memory queue and outbox for each test.

**The handlers read the services from the context.** `servicesPlugin` (`src/http/services-plugin.ts`) exposes them as `ctx.services`, declared by module augmentation: the IDE completes `ctx.services.tasks.` with the methods of the repository and their arguments, as it does for `ctx.user`, `ctx.cache` or `ctx.events`. The route files stay plain modules: no singleton to import, no dependencies to pass around.

**Events belong to the feature that emits them, listeners to the feature that reacts.** `features/tasks/events.ts` defines `task.assigned`; `features/notifications/listeners.ts` reacts to it.

Each feature has its own example, closer to the details: `auth` (cookies, rotation, logout), `cache` (grace period, invalidation), `events` (worker command, retries), `mailer` (previews, SMTP) and `express` (OpenAPI).
