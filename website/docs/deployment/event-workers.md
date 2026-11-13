# Event workers

The listeners of [`@dotpress/events`](/services/events) run in workers: processes that read a queue and run the listener of each message. This page covers where to run them, and how to set up each queue.

## Choose a queue

| Queue | Transport | Workers | When |
| --- | --- | --- | --- |
| Redis | BullMQ | a container | You already run Redis, or want the simplest queue next to a server |
| Postgres | pg-boss | a container | No other infrastructure than your database |
| Amazon SQS | SQS | Lambda functions, or a container | On AWS, with an API on Lambda or containers |
| Cloudflare Queues | Cloudflare | Workers, or a container | On Cloudflare |
| Google Cloud Pub/Sub | Pub/Sub | push endpoints (Cloud Run…), or a container | On Google Cloud |
| Azure Service Bus | Service Bus | Azure Functions, or a container | On Azure |

The code that emits does not change from one to another: only the transport of the bus, and the entry point of the worker.

## Rules for every queue

- **Configure a dead-letter queue.** After its last attempt, a failing message goes there, where you inspect it and replay it. Dead-letter queues are part of your infrastructure: each section below gives the setting.
- **Align the attempts.** Set `maxAttempts` of the worker to the retry limit of the queue: `onFailure` then reports the last attempt as `final`, for your alerts.
- **Give listeners enough time.** The visibility timeout, lease or lock of a message must outlast your slowest listener, or the message is delivered again while it runs.
- **Make listeners idempotent.** Every queue delivers at least once: use the message `id` to ignore duplicates. See [Retries and idempotency](/services/events#retries-and-idempotency).
- **Deploy workers before routing events to them.** A message for a listener its worker does not know fails as `unknown-listener`. When you rename a listener, deploy workers that know both names first.

## Long-running workers

On a server or in a container, a worker is started by `dotpress-events work`, with a module that exports the `worker` and the `source` of its messages:

```sh
node_modules/.bin/dotpress-events work src/worker.ts
```

```ts file="<root>/../examples/events/src/worker.ts"
```

- **Stop**: `SIGTERM` (or Ctrl+C) stops reading, and waits for the messages in progress; a second signal, a second later or more, exits at once. Give the platform a stop delay above your slowest listener.
- **Logs**: JSON lines on the standard error.
- **Scale**: raise the `concurrency` of the source (messages handled at once by a worker), then the number of worker instances.
- **In a container**: the image of the API, with another command. See [Containers](./node#containers).

In code, `startWorker(worker, source, { logger, signal })` does the same, and returns `{ stop() }`.

## Redis (BullMQ)

```sh
npm install bullmq ioredis
```

```ts
import { createBullmqSource, createBullmqTransport } from '@dotpress/events/bullmq'

const connection = { host: 'redis.internal', port: 6379, maxRetriesPerRequest: null }

// The API
const transport = createBullmqTransport({ name: 'events', connection })
// On shutdown: await transport.close()

// worker.ts
export default {
  worker: createWorker({ listeners, maxAttempts: 3 }),
  source: createBullmqSource({ name: 'events', connection, concurrency: 5 }),
}
```

- **Redis 6.2 or later, with `maxmemory-policy=noeviction`**: Redis must never evict the keys of the queue. A managed Redis often defaults to another policy: check it.
- **Retries**: 3 attempts, with an exponential backoff from 1 second (`jobOptions` to change them). Set `maxAttempts` to the same number.
- **Dead letters**: failed jobs stay in the failed set of the queue, with their error, where a dashboard such as Bull Board shows and retries them.
- **Stop**: the source waits for the jobs in progress, up to `closeTimeout` (30 seconds by default).

For development, the [Events example](/examples/events) starts Redis with Docker Compose:

```yaml file="<root>/../examples/events/compose.yaml"
```

## Amazon SQS

```sh
npm install @aws-sdk/client-sqs
```

```ts
import { createSqsTransport } from '@dotpress/events/aws-sqs'

const transport = createSqsTransport({ queueUrl: process.env.EVENTS_QUEUE_URL! })
```

Messages are limited to 1 MiB, and `delay` to 15 minutes. FIFO queues (URL ending with `.fifo`) keep the order within a message group, and do not accept delays.

### Lambda workers

```ts
import { createSqsHandler } from '@dotpress/events/aws-sqs'

export const handler = createSqsHandler(createWorker({ listeners, logger, maxAttempts: 5 }), {
  deadLetterQueueUrl: process.env.EVENTS_DLQ_URL, // optional, see below
  retryDelay: (attempt) => 30 * 2 ** (attempt - 1), // optional backoff, in seconds
})
```

Configure the queue and its trigger:

- **`ReportBatchItemFailures`** on the event source mapping: only the failed messages of a batch are retried. Without it, one failure retries the whole batch.
- **A dead-letter queue**, with a redrive policy: `maxReceiveCount` is the number of attempts. Set `maxAttempts` to the same value.
- **A visibility timeout** of at least 6 times the timeout of the function (AWS recommendation).
- With `deadLetterQueueUrl`, messages that can never be handled (invalid payload, unknown listener) are copied to the dead-letter queue at once, instead of failing until `maxReceiveCount`.

### Long-running workers

```ts
import { createSqsSource } from '@dotpress/events/aws-sqs'

export default {
  worker: createWorker({ listeners, maxAttempts: 5 }),
  source: createSqsSource({ queueUrl: process.env.EVENTS_QUEUE_URL!, visibilityTimeout: 60 }),
}
```

The source reads the queue by long polling, and extends the visibility of a message while its listener runs. During development, `dotpress-events work` reads your development queue as the Lambda would, without deploying.

## Postgres (pg-boss)

```sh
npm install pg-boss
```

```ts
import { createPgBossSource, createPgBossTransport } from '@dotpress/events/pg-boss'

const boss = process.env.DATABASE_URL!
const queueOptions = { deadLetter: 'events-dlq' }

// The API
const transport = createPgBossTransport({ boss, queue: 'events', queueOptions })

// worker.ts
export default {
  worker: createWorker({ listeners, maxAttempts: 3 }),
  source: createPgBossSource({ boss, queue: 'events', queueOptions, batchSize: 5 }),
}
```

[pg-boss](https://pgboss.io) keeps the queue in your Postgres database (13 or later). The queues are created on first use, with 3 attempts and an exponential backoff; with `deadLetter`, failed jobs go to the dead-letter queue. Set `maxAttempts` to `retryLimit + 1`.

## Cloudflare Queues

```jsonc
// wrangler.jsonc
{
  "queues": {
    "producers": [{ "queue": "events", "binding": "EVENTS_QUEUE" }],
    "consumers": [
      { "queue": "events", "max_batch_size": 10, "max_retries": 5, "dead_letter_queue": "events-dlq" }
    ]
  }
}
```

```ts
import {
  createCloudflareQueueHandler,
  createCloudflareQueueTransport,
} from '@dotpress/events/cloudflare-queues'

// Sending, inside a Worker
const transport = createCloudflareQueueTransport({ queue: () => env.EVENTS_QUEUE })
// Sending from elsewhere, with the REST API
const transport = createCloudflareQueueTransport({ accountId, queueId, apiToken })

// The consumer Worker
export default {
  queue: createCloudflareQueueHandler(createWorker({ listeners, maxAttempts: 6 })),
}
```

Each message is acknowledged or retried on its own. After `max_retries`, Cloudflare moves it to the `dead_letter_queue`; set `maxAttempts` to `max_retries + 1`. Messages are limited to 128 KB, and `delay` to 24 hours.

To run the workers outside Cloudflare, enable an HTTP pull consumer on the queue, and use `createCloudflarePullSource()` with `dotpress-events work`.

## Google Cloud Pub/Sub

```ts
import { createPubSubTransport } from '@dotpress/events/google-pubsub'

const transport = createPubSubTransport({ topic: 'projects/my-project/topics/events' })
```

The transport publishes with the REST API, authenticated by Application Default Credentials (`google-auth-library`); the account needs the Pub/Sub Publisher role. Pub/Sub does not support delays.

Create the subscription with a dead-letter policy, and an ack deadline above your slowest listener:

```sh
gcloud pubsub subscriptions create events-worker --topic=events \
  --ack-deadline=60 --min-retry-delay=10s --max-retry-delay=600s \
  --dead-letter-topic=events-dlq --max-delivery-attempts=5
```

Workers receive the messages:

- **by push**, on an HTTP endpoint (Cloud Run…): `createPubSubPushHandler()` verifies the OIDC token signed by Google, and answers `204` or `503`;
- **by pull**, in a container: `createPubSubPullSource({ subscription })` with `dotpress-events work`.

Set `maxAttempts` to `--max-delivery-attempts`.

## Azure Service Bus

```sh
npm install @azure/service-bus
```

```ts
import {
  createServiceBusSource,
  createServiceBusTransport,
} from '@dotpress/events/azure-service-bus'

const connection = { connectionString: process.env.SERVICE_BUS_CONNECTION! }

// The API
const transport = createServiceBusTransport({ ...connection, queue: 'events' })

// worker.ts
export default {
  worker: createWorker({ listeners, maxAttempts: 10 }), // the maxDeliveryCount of the queue
  source: createServiceBusSource({ ...connection, queue: 'events', maxConcurrentCalls: 4 }),
}
```

A failed message is delivered again at once, until the `maxDeliveryCount` of the queue (10 by default), then moved to its dead-letter queue. Service Bus does not wait between attempts: retry short outages inside the listener. Enable duplicate detection on the queue (`requiresDuplicateDetection`) to ignore repeated emissions.

On Azure Functions, `createServiceBusFunctionHandler()` handles the messages of a `serviceBusQueue` trigger. Microsoft Entra ID credentials work too: pass a `ServiceBusClient` instead of the connection string.

## Monitoring

- **`onFailure`** on the worker receives each failure, with `final` on the last attempt: raise an alert on final failures.
- **Logs**: `Event listener failed, the message is retried` (warn), `Event listener failed, the message is not retried` (error). Payloads are never logged.
- **Dead-letter queues**: watch their size. A growing dead-letter queue is a bug, or a service down.
