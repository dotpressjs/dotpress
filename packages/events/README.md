# @dotpress/events

Typed events for [Dotpress](https://dotpress.dev): emit a fact, and let listeners react to it in workers, through interchangeable transports: Redis (BullMQ), Postgres (pg-boss), Amazon SQS, Cloudflare Queues, Google Cloud Pub/Sub, Azure Service Bus. The code that emits never knows where the listeners run. Works without a Dotpress app: in a script, a worker or a Lambda function.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

```sh
npm install @dotpress/events zod
```

```ts
import { createEventBus, createMemoryTransport, defineEvent, defineListener } from '@dotpress/events'
import { z } from 'zod'

// An event: a fact, with the schema of its payload
export const userCreated = defineEvent({
  name: 'user.created',
  schema: z.object({ userId: z.string() }),
})

// Listeners react to it, each retried on its own
export const syncCrm = defineListener(userCreated, {
  name: 'sync-crm',
  handle: async ({ payload }) => crm.addContact(payload.userId),
})

const events = createEventBus({
  transport: createMemoryTransport(), // a real queue in production
  listeners: [syncCrm],
})

await events.emit(userCreated, { userId: '42' })
```

Workers run the listeners: `dotpress-events work src/worker.ts` in a container, or the handler of the platform (AWS Lambda, Cloudflare Workers, Azure Functions, Pub/Sub push endpoints).

## Documentation

- [Events and workers](https://dotpress.dev/services/events): events, listeners, idempotency, emitting, transports, workers, failures, testing
- [Event workers](https://dotpress.dev/deployment/event-workers): the setup of each queue, dead letters, limits, monitoring
- [Events reference](https://dotpress.dev/reference/events): every option, failure reasons, logs, errors, custom transports

## License

MIT
