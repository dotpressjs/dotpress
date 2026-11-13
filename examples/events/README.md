# Dotpress events

An orders API with [Dotpress](https://dotpress.dev) and `@dotpress/events`, on [Fastify](https://fastify.dev): placing an order emits an `order.placed` event, and its listeners run later, in a worker, through a Redis queue ([BullMQ](https://docs.bullmq.io)).

- The API answers without waiting for the listeners: it only queues one message per listener.
- `send-order-confirmation` logs the confirmation (replace it with your mailer); `notify-warehouse` sends the order to a warehouse service over HTTP, with an idempotency key.
- A listener that throws is retried (3 attempts, exponential backoff), then kept in the failed jobs of the queue.
- Without Redis, an in-memory queue runs the listeners in the API process: nothing to install to try it.

## Run it

Requires Node.js 22.18 or later: Node.js runs the TypeScript sources directly.

```sh
npx degit dotpressjs/dotpress/examples/events my-api
cd my-api
npm install
npm run dev
```

```sh
curl -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"items":[{"sku":"BOOK-1","quantity":2}]}'
```

The logs of the API show the listeners running. Set `WAREHOUSE_URL` to send the orders to a service; without it, `notify-warehouse` only logs.

### With Redis

```sh
docker compose up -d # Redis, from compose.yaml
REDIS_URL=redis://localhost:6379 npm run dev # terminal 1: the API
REDIS_URL=redis://localhost:6379 npm run worker # terminal 2: the worker
```

The API now queues the messages in Redis, and the worker runs the listeners: stop the worker, place orders, then start it again, and it handles them. `npm run worker` runs `dotpress-events work src/worker.ts --watch`, which restarts when a file changes. Ctrl+C stops it after the jobs in progress.

`npm test` runs the tests (the ones with Redis when `REDIS_URL` is set), `npm run typecheck` checks the types.

## Deploy

Run the API and the worker as two processes (two containers, for example), with the same variables:

| Variable | Content |
| --- | --- |
| `REDIS_URL` | `redis://` or `rediss://` (TLS) URL, with the user, password and database number if needed. Redis 6.2 or later, with `maxmemory-policy=noeviction` |
| `EVENTS_QUEUE` | Name of the queue. Defaults to `events` |
| `WAREHOUSE_URL` | The warehouse service |
| `PORT` | Port of the API. Defaults to `3000` |

Run the worker with `npx dotpress-events work src/worker.ts`, without `--watch`. On SIGTERM, it finishes the jobs in progress (30 seconds at most) before exiting.

Listeners can run twice: a retry after a timeout, a duplicate delivery. `notify-warehouse` sends the message id as idempotency key, so that the service ignores duplicates. The orders are kept in memory: replace `src/orders.ts` with your database, and emit the event after the transaction commits.

## Files

| File | Content |
| --- | --- |
| `src/events.ts` | The event and its listeners, shared by the API and the worker |
| `src/listeners/` | The code of the listeners, loaded by the worker only |
| `src/bus.ts` | The transport (BullMQ or in-memory) and the event bus of the API |
| `src/routes.ts` | The routes, emitting the event with `ctx.events` |
| `src/orders.ts` | The orders, to replace with your database |
| `src/app.ts` | The app, with the events plugin |
| `src/server.ts` | The Fastify server |
| `src/worker.ts` | The worker, for `dotpress-events work` |
| `compose.yaml` | Redis, for development |
| `test/orders.test.ts` | The routes, with a fake event bus |
| `test/listeners.test.ts` | The listeners, with an in-memory queue: retries, last attempt |
| `test/server.test.ts` | The API over HTTP, without Redis |
| `test/redis.test.ts` | The API and the `dotpress-events work` command, with Redis |

The [event workers guide](https://dotpress.dev/deployment/event-workers) covers the other transports (Amazon SQS, Cloudflare Queues, Postgres, Google Cloud Pub/Sub, Azure Service Bus), several transports in one bus, and serverless workers.
