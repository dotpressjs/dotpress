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

| Queue | Message size | `delay` | The same message sent again |
| --- | --- | --- | --- |
| BullMQ | — | no limit | ignored while the job exists |
| pg-boss | — | no limit | ignored |
| SQS | 1 MiB | 15 minutes; none on FIFO queues | ignored for 5 minutes on FIFO queues |
| Cloudflare Queues | 128 KB | 24 hours | — |
| Pub/Sub | about 7.5 MB | not supported | — |
| Service Bus | 256 KB (Standard), 1 MB or more (Premium) | no limit | ignored with duplicate detection |

A message larger than the limit fails at `emit()`, with an `EventEmitError`; the other messages of the emission are sent.

## Rules for every queue

- **Configure a dead-letter queue.** After its last attempt, a failing message goes there, where you inspect it and replay it. Dead-letter queues are part of your infrastructure (CDK, Terraform, Wrangler…): each section below gives the setting.
- **Align the attempts.** Set `maxAttempts` of the worker to the retry limit of the queue: `onFailure` then reports the last attempt as `final`, for your alerts.
- **Give listeners enough time.** The visibility timeout, lease or lock of a message must outlast your slowest listener, or the message is delivered again while it runs.
- **Make listeners idempotent.** Every queue delivers at least once: use the message `id` to ignore duplicates. See [Retries and idempotency](/services/events#retries-and-idempotency).
- **Deploy workers before routing events to them.** A message for a listener its worker does not know fails as `unknown-listener`. When you rename a listener, deploy workers that know both names first.

**Messages that can never be handled** (not an envelope, unknown listener, invalid payload) are `dead`: retrying would not help. When the transport can send them to the dead-letter queue directly, they go there at once; otherwise, they fail until the retry limit, like other failures.

## Long-running workers

On a server or in a container, a worker is started by `dotpress-events work`, with a module that exports the `worker` and the `source` of its messages:

```sh
node_modules/.bin/dotpress-events work src/worker.ts
node_modules/.bin/dotpress-events work src/worker.ts --watch # development: restarts when a file changes
```

```ts file="<root>/../examples/events/src/worker.ts"
```

- **The module** exports `{ worker, source }` and optionally a `logger`, or a function returning them; `--export` chooses another export than `default`. TypeScript modules need Node.js 22.18 or later (erasable syntax, relative imports ending in `.ts`); otherwise, run the compiled module, or the command with `NODE_OPTIONS="--import tsx"`.
- **Stop**: `SIGTERM` (or Ctrl+C) stops reading, and waits for the messages in progress; a second signal, a second later or more, exits at once. Repeats within one second are ignored, because `npm run`, `pnpm run` and `--watch` relay the signal they receive. Give the platform a stop delay above your slowest listener.
- **Logs**: JSON lines on the standard error.
- **Scale**: raise the number of messages a worker handles at once (`concurrency` for BullMQ, `batchSize` for SQS, pg-boss and Cloudflare, `maxMessages` for Pub/Sub, `maxConcurrentCalls` for Service Bus), then the number of worker instances.
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

Each message becomes a [BullMQ](https://docs.bullmq.io) job named after its listener, with the message id as job id: the same message sent again adds no duplicate while the job exists.

- **Redis 6.2 or later, with `maxmemory-policy=noeviction`**: Redis must never evict the keys of the queue. A managed Redis often defaults to another policy: check it.
- **Retries** (`jobOptions`, merged with the defaults): 3 `attempts`, an `exponential` backoff from 1 second, completed jobs removed (`removeOnComplete: true`), failed jobs kept (`removeOnFail: false`). Set `maxAttempts` to the same number.
- **Dead letters**: failed jobs stay in the failed set of the queue, with their error, where a dashboard such as Bull Board shows and retries them. Messages that can never be handled fail at once, without retries (`UnrecoverableError`).
- **The source** handles `concurrency` jobs at a time (1 by default). On stop, it waits for the jobs in progress, up to `closeTimeout` (30 seconds by default); their jobs then become stalled, and another worker retries them. While Redis is unreachable, BullMQ cannot close: the stop gives up after `closeTimeout`.
- **Connection**: use the `prefix` option for the key prefix, not the `keyPrefix` of ioredis. An ioredis instance passed as `connection` needs `maxRetriesPerRequest: null`. Pass `queue` instead of `name` and `connection` to reuse a BullMQ `Queue`.
- BullMQ runs on Node.js and Bun.

For development, the [Events example](/examples/events) starts Redis with Docker Compose:

```yaml file="<root>/../examples/events/compose.yaml"
```

## Postgres (pg-boss)

```sh
npm install pg-boss
```

```ts
import { createPgBossSource, createPgBossTransport } from '@dotpress/events/pg-boss'

const boss = process.env.DATABASE_URL! // or pg-boss options, or a started instance
const queueOptions = { deadLetter: 'events-dlq' }

// The API
const transport = createPgBossTransport({ boss, queue: 'events', queueOptions })
// On shutdown: await transport.close()

// worker.ts
export default {
  worker: createWorker({ listeners, maxAttempts: 3 }),
  source: createPgBossSource({ boss, queue: 'events', queueOptions, batchSize: 5 }),
}
```

[pg-boss](https://pgboss.io) keeps the queue in your Postgres database (13 or later), and needs Node.js 22.12 or later, or Bun. With a connection string or options, the transport and the source start their own pg-boss instance (`close()` stops the one of the transport); pass a started instance to share it.

- **Queues** are created on first use, with `queueOptions` merged with the defaults: 3 attempts (`retryLimit: 2`), an exponential backoff from 1 second (`retryDelay: 1`, `retryBackoff: true`). Existing queues are not changed. Set `maxAttempts` to `retryLimit + 1`.
- **Dead letters**: with `deadLetter`, the dead-letter queue is created too. Failed jobs go there after their last attempt, and messages that can never be handled at once.
- **Duplicates**: the job id is the message id: the same message sent again is ignored.
- **The source** handles `batchSize` jobs at a time (1 by default), in parallel, each with its own result: one failure does not retry the others. `pollingIntervalSeconds` sets the wait on an empty queue (0.5 at least). On stop, it waits for the jobs in progress, up to `closeTimeout` (30 seconds by default).

## Amazon SQS

```sh
npm install @aws-sdk/client-sqs
```

```ts
import { createSqsTransport } from '@dotpress/events/aws-sqs'

const transport = createSqsTransport({ queueUrl: process.env.EVENTS_QUEUE_URL! })
```

Messages are sent in batches of 10 (`SendMessageBatch`), with `event` and `listener` message attributes. The client comes from the environment (region, credentials), or from `clientConfig`; pass `client` to reuse yours.

**FIFO queues** (URL ending with `.fifo`) keep the order within a message group: the listener by default, or `messageGroupId: (envelope) => …` to group by entity. They deduplicate messages by id for 5 minutes, and do not accept delays.

### Lambda workers

```ts
import { createSqsHandler } from '@dotpress/events/aws-sqs'

export const handler = createSqsHandler(createWorker({ listeners, logger, maxAttempts: 5 }), {
  deadLetterQueueUrl: process.env.EVENTS_DLQ_URL, // optional, see below
  retryDelay: (attempt) => 30 * 2 ** (attempt - 1), // optional backoff, in seconds
})
```

The messages of a batch run in parallel; on a FIFO queue, in order, stopping at the first failure. Configure the queue and its trigger:

- **`ReportBatchItemFailures`** on the event source mapping: the handler returns the failed messages, and only they are retried. Without it, one failure retries the whole batch.
- **A dead-letter queue**, with a redrive policy: `maxReceiveCount` is the number of attempts. Set `maxAttempts` to the same value.
- **A visibility timeout** of at least 6 times the timeout of the function (AWS recommendation). A failed message becomes visible again after it; `retryDelay(attempt)` sets another delay (`ChangeMessageVisibility`, up to 12 hours).
- With `deadLetterQueueUrl`, messages that can never be handled are copied to the dead-letter queue at once, with `reason` and `error` attributes, instead of failing until `maxReceiveCount`.

```ts
// AWS CDK
const dlq = new sqs.Queue(this, 'EventsDlq', { retentionPeriod: Duration.days(14) })
const queue = new sqs.Queue(this, 'Events', {
  visibilityTimeout: Duration.seconds(180), // 6 × the timeout of the function
  deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
})
worker.addEventSource(new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }))
```

```hcl
# Terraform
resource "aws_sqs_queue" "events_dlq" {
  name                      = "events-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "events" {
  name                       = "events"
  visibility_timeout_seconds = 180
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.events_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_lambda_event_source_mapping" "events" {
  event_source_arn        = aws_sqs_queue.events.arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
}
```

**IAM permissions**: `sqs:SendMessage` for the code that emits. For workers, `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes` (granted by the event source mapping on Lambda); `sqs:ChangeMessageVisibility` with `retryDelay` or `visibilityTimeout`; `sqs:SendMessage` on the dead-letter queue with `deadLetterQueueUrl`.

### Long-running workers

```ts
import { createSqsSource } from '@dotpress/events/aws-sqs'

export default {
  worker: createWorker({ listeners, maxAttempts: 5 }),
  source: createSqsSource({ queueUrl: process.env.EVENTS_QUEUE_URL!, visibilityTimeout: 60 }),
}
```

The source reads the queue by long polling (`waitTimeSeconds`, 20 by default; `batchSize`, 10 by default), runs the messages of a batch in parallel, and deletes the handled ones. With `visibilityTimeout`, it extends the visibility of a message while its listener runs, every half timeout. Receive errors are logged and retried, after 1 second, then up to 30 seconds. At startup, it warns when the queue has no dead-letter queue.

During development, `dotpress-events work` reads your development queue as the Lambda would, without deploying.

## Cloudflare Queues

No dependency: the transport uses the binding of the queue inside Workers, and `fetch` elsewhere.

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
import { createCloudflareQueueTransport } from '@dotpress/events/cloudflare-queues'

// Sending, inside a Worker: the producer binding
const workerTransport = createCloudflareQueueTransport({ queue: () => env.EVENTS_QUEUE })
// Sending from elsewhere (Node.js, Lambda…): the REST API
const restTransport = createCloudflareQueueTransport({
  accountId: process.env.CF_ACCOUNT_ID!,
  queueId: process.env.CF_QUEUE_ID!, // the ID of the queue, not its name
  apiToken: process.env.CF_API_TOKEN!, // Queues Write permission
})
```

`queue` also accepts the binding itself. Messages are sent as JSON, in batches of 100 messages and 256 KB at most; a message is limited to 128 KB, including about 100 bytes of metadata.

### Worker consumers

```ts
import { createCloudflareQueueHandler } from '@dotpress/events/cloudflare-queues'

export default {
  queue: createCloudflareQueueHandler(createWorker({ listeners, maxAttempts: 6 }), {
    retryDelay: (attempt) => 30 * attempt, // optional, in seconds
    deadLetterQueue: () => env.EVENTS_DLQ, // optional producer binding, see below
  }),
}
```

Each message is acknowledged or retried on its own: a failure does not retry the whole batch. After `max_retries`, Cloudflare moves the message to the `dead_letter_queue` of the consumer; without one, the message is deleted. Set `maxAttempts` to `max_retries + 1`. With `deadLetterQueue`, a producer binding to the dead-letter queue, messages that can never be handled are sent there at once.

### Pull consumers

To run the workers outside Cloudflare (a container, your machine with `dotpress-events work`), enable an HTTP pull consumer on the queue: `wrangler queues consumer http add events`. A queue has either a Worker consumer or a pull consumer.

```ts
import { createCloudflarePullSource } from '@dotpress/events/cloudflare-queues'

export default {
  worker: createWorker({ listeners, maxAttempts: 6 }),
  source: createCloudflarePullSource({
    accountId,
    queueId,
    apiToken, // Queues Read and Write permissions
    visibilityTimeoutMs: 60_000, // the lease: longer than your slowest listener
    deadLetterQueueId, // optional: dead messages are pushed there at once
  }),
}
```

The source pulls `batchSize` messages (10 by default, up to 100), runs them in parallel, then acknowledges or retries them in one request. The API cannot extend a lease: set `visibilityTimeoutMs` (30 seconds by default, up to 12 hours) above your slowest listener. An empty queue is pulled again after `pollInterval` (1 second by default). Errors are logged and retried, after 1 second, then up to 30 seconds.

## Google Cloud Pub/Sub

```sh
npm install google-auth-library  # to publish with Application Default Credentials
npm install jose                 # push endpoints: to verify the tokens
npm install @google-cloud/pubsub # pull workers
```

Each one is optional: install what you use.

```ts
import { createPubSubTransport } from '@dotpress/events/google-pubsub'

const transport = createPubSubTransport({ topic: 'projects/my-project/topics/events' })
```

The transport publishes over the REST API, with `fetch`: it runs on Node.js, Bun, Deno and Cloudflare Workers. Each message carries the attributes `event` and `listener`: a subscription can filter on them (`--message-filter='attributes.listener = "send-welcome-mail"'`) to run some listeners on other workers.

- **Authentication**: an OAuth token from Application Default Credentials, through `google-auth-library` (the service account of Cloud Run, GKE or Cloud Functions, `GOOGLE_APPLICATION_CREDENTIALS`, or `gcloud auth application-default login`). The account needs the Pub/Sub Publisher role (`roles/pubsub.publisher`) on the topic. Elsewhere, pass `getAccessToken`, which returns a token with the `https://www.googleapis.com/auth/pubsub` scope. For the emulator: `baseUrl: 'http://localhost:8085', getAccessToken: false`.
- **Limits**: 10 MB and 1,000 messages per request (larger emissions are split); 10 MB per message with its base64-encoded envelope, about 7.5 MB of JSON. Pub/Sub does not support delays: an emission with a `delay` fails.

### Subscriptions and dead letters

```sh
gcloud pubsub topics create events
gcloud pubsub topics create events-dlq
gcloud pubsub subscriptions create events-worker --topic=events \
  --ack-deadline=60 --min-retry-delay=10s --max-retry-delay=600s \
  --dead-letter-topic=events-dlq --max-delivery-attempts=5
```

With a dead-letter policy, Pub/Sub counts the delivery attempts, and moves a message to the dead-letter topic after `--max-delivery-attempts` (5 to 100); its service account needs the Publisher role on the dead-letter topic and the Subscriber role on the subscription. Set `maxAttempts` to `--max-delivery-attempts`. Without a dead-letter policy, every delivery counts as the first attempt, and a failing message is delivered again until the retention of the subscription expires (7 days by default).

With the `deadLetter` option of the push handler or `deadLetterTopic` of the pull source, messages that can never be handled are published at once to that topic, with the attributes `reason` and `error`.

### Push endpoints

A push subscription POSTs each message to your endpoint, with an OIDC token signed by Google:

```sh
gcloud pubsub subscriptions create events-push --topic=events \
  --push-endpoint=https://api.example.com/pubsub \
  --push-auth-service-account=pubsub-push@my-project.iam.gserviceaccount.com \
  --ack-deadline=60 --dead-letter-topic=events-dlq --max-delivery-attempts=5
```

```ts
import { createPubSubPushHandler } from '@dotpress/events/google-pubsub'

const push = createPubSubPushHandler(createWorker({ listeners, maxAttempts: 5 }), {
  audience: 'https://api.example.com/pubsub', // the push endpoint, or --push-auth-token-audience
  serviceAccountEmail: 'pubsub-push@my-project.iam.gserviceaccount.com',
  deadLetter: { topic: 'projects/my-project/topics/events-dlq' }, // optional
})

// Web-standard runtimes (Hono, Cloudflare Workers, Bun, Deno)
app.post('/pubsub', (c) => push.fetch(c.req.raw))
// Other frameworks: the parsed JSON body and the Authorization header
app.post('/pubsub', async (req, res) => {
  res.status(await push.handle(req.body, req.headers.authorization)).end()
})
```

The handler verifies the token with `jose`: the signature with the keys of Google, the issuer, the `audience`, a verified `email`, equal to `serviceAccountEmail` when set. It answers `204` when the message is handled (or moved to `deadLetter`), `503` to have it delivered again, `401` and `403` for invalid tokens, `400` for bodies that are not push messages. Set `verifyToken: false` only behind a proxy that checks the token. Pub/Sub waits up to the ack deadline of the subscription (10 seconds by default, up to 600): set it above your slowest listener.

### Pull workers

```ts
import { createPubSubPullSource } from '@dotpress/events/google-pubsub'

export default {
  worker: createWorker({ listeners, maxAttempts: 5 }),
  source: createPubSubPullSource({
    subscription: 'projects/my-project/subscriptions/events-worker',
    maxMessages: 10, // messages handled at once (the default)
    deadLetterTopic: 'projects/my-project/topics/events-dlq', // optional
  }),
}
```

The source uses the streaming pull of `@google-cloud/pubsub` (Node.js), which extends the ack deadline of the messages in progress. Credentials come from Application Default Credentials, `clientConfig` (options of `new PubSub()`), or the `client` you pass; the emulator is used when `PUBSUB_EMULATOR_HOST` is set. On stop, the source waits for the messages in progress, up to `closeTimeout` (30 seconds by default).

## Azure Service Bus

```sh
npm install @azure/service-bus
```

```ts
import { createServiceBusSource, createServiceBusTransport } from '@dotpress/events/azure-service-bus'

const connection = { connectionString: process.env.SERVICE_BUS_CONNECTION! }
// Or Microsoft Entra ID:
// const connection = { client: new ServiceBusClient('my-namespace.servicebus.windows.net', new DefaultAzureCredential()) }

// The API
const transport = createServiceBusTransport({ ...connection, queue: 'events' })
// On shutdown: await transport.close()

// worker.ts
export default {
  worker: createWorker({ listeners, maxAttempts: 10 }), // the maxDeliveryCount of the queue
  source: createServiceBusSource({ ...connection, queue: 'events', maxConcurrentCalls: 4 }),
}
```

The SDK speaks AMQP: Node.js only. With a connection string, the transport and the source create their own client (`close()` closes the one of the transport); pass a `client` to share it, or to use Microsoft Entra ID (`@azure/identity`, with the Azure Service Bus Data Sender or Data Receiver role).

- **Messages** carry the envelope as JSON, `subject` (the event) and the application properties `event` and `listener`. The `messageId` is the message id: with duplicate detection on the queue (`requiresDuplicateDetection`, set when the queue is created; Standard and Premium tiers), the same message sent again within the detection window is ignored. `delay` schedules the message (`scheduledEnqueueTimeUtc`).
- **Limits**: 256 KB per message in the Standard tier, properties included; in the Premium tier, 1 MB unless raised on the queue (up to 100 MB). Batches are filled up to the size the queue accepts, 1 MB at most.
- **The source** handles `maxConcurrentCalls` messages at a time (1 by default), in peek-lock mode. The lock of a message in progress is renewed for `maxAutoLockRenewalDurationInMs` (5 minutes by default; the lock itself lasts 1 minute by default, 5 at most). A failed message is abandoned: Service Bus delivers it again at once, until the `maxDeliveryCount` of the queue (10 by default), then moves it to the dead-letter queue. Messages that can never be handled go there at once, with a `deadLetterReason` (`invalid-envelope`, `unknown-listener`, `invalid-payload`). On stop, the source waits for the messages in progress, up to `closeTimeout` (30 seconds by default).

Service Bus does not wait between attempts: a listener that calls a service which is down fails its attempts within seconds. Keep `maxDeliveryCount` high enough, and retry short outages inside the listener.

### Azure Functions

```ts
import { app } from '@azure/functions'
import { createServiceBusFunctionHandler } from '@dotpress/events/azure-service-bus'

app.serviceBusQueue('events', {
  connection: 'SERVICE_BUS_CONNECTION',
  queueName: 'events',
  handler: createServiceBusFunctionHandler(createWorker({ listeners, maxAttempts: 10 }), {
    // optional, see below
    deadLetter: { connectionString: process.env.SERVICE_BUS_CONNECTION!, queue: 'events-failed' },
  }),
})
```

The handler takes one message per invocation (`cardinality: 'one'`, the default). A failure throws: the Functions host abandons the message, delivered again until `maxDeliveryCount`, then moved to the dead-letter queue. `attempt` is the `deliveryCount` of the trigger metadata. A function cannot move a message to the dead-letter queue itself: with `deadLetter`, messages that can never be handled are sent to that queue, with the properties `reason` and `error`, and the invocation succeeds.

## Monitoring

- **`onFailure`** on the worker receives each failure, with `final` on the last attempt: raise an alert on final failures.
- **Logs**: `Event listener failed, the message is retried` (warn), `Event listener failed, the message is not retried` (error). Payloads are never logged. See [the logs](/reference/events#logs).
- **Dead-letter queues**: watch their size. A growing dead-letter queue is a bug, or a service down.
