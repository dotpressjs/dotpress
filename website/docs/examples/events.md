# Events

An orders API with `@dotpress/events`, on Fastify. Placing an order emits an `order.placed` event; its two listeners run later, in a worker, through a Redis queue ([BullMQ](https://docs.bullmq.io)):

- the API answers without waiting for the listeners: it only queues one message per listener;
- `send-order-confirmation` logs the confirmation, and `notify-warehouse` calls a warehouse service over HTTP, with an idempotency key;
- a listener that throws is retried (3 attempts, exponential backoff), then kept in the failed jobs of the queue;
- without Redis, an in-memory queue runs the listeners in the API process: nothing to install to try it.

Source: [`examples/events`](https://github.com/dotpressjs/dotpress/tree/main/examples/events).

## Run it

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

The logs of the API show the listeners running.

### With Redis

```sh
docker compose up -d # Redis
REDIS_URL=redis://localhost:6379 npm run dev # terminal 1: the API
REDIS_URL=redis://localhost:6379 npm run worker # terminal 2: the worker
```

Stop the worker, place orders, then start it again: it handles the orders that waited in the queue. `npm run worker` runs `dotpress-events work src/worker.ts --watch`.

## The event and its listeners

Shared by the API and the worker. `load` imports the code of a listener in the worker only:

```ts file="<root>/../examples/events/src/events.ts"
```

A listener can run twice: the message `id` is the idempotency key sent to the warehouse service.

```ts file="<root>/../examples/events/src/listeners/notify-warehouse.ts"
```

## Emitting

The route stores the order, then emits: an event describes something that happened.

```ts file="<root>/../examples/events/src/routes.ts"
```

The transport comes from the configuration: BullMQ with `REDIS_URL`, an in-memory queue without it.

```ts file="<root>/../examples/events/src/bus.ts"
```

## The worker

```ts file="<root>/../examples/events/src/worker.ts"
```

In production, run the API and the worker as two processes, with `dotpress-events work src/worker.ts` (without `--watch`). On `SIGTERM`, the worker finishes the jobs in progress before exiting.

## Learn more

- [Events and workers](/services/events)
- [Deployment › Event workers](/deployment/event-workers): SQS, pg-boss, Cloudflare Queues, Pub/Sub, Service Bus
- [Testing helpers](/services/testing#events)
