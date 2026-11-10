# @dotpress/events

Typed events for [Dotpress](https://dotpress.dev): emit a fact, and let listeners react to it in workers, through interchangeable transports. The code that emits never knows where or how the listeners run. Works without a Dotpress app: in a script, a worker or a Lambda function.

> 🚧 Dotpress V2 is under active development and not published yet.

```sh
pnpm add @dotpress/events zod
pnpm add @dotpress/core # for eventsPlugin
```

## Quick start

```ts
import {
  createEventBus,
  createMemoryTransport,
  defineEvent,
  defineListener,
} from '@dotpress/events'
import { z } from 'zod'

// An event: a fact, with the schema of its payload.
export const practitionerCreated = defineEvent({
  name: 'practitioner.created',
  schema: z.object({ practitionerId: z.string() }),
})

// Listeners react to it, independently.
export const sendWelcomeMail = defineListener(practitionerCreated, {
  name: 'send-welcome-mail',
  handle: async ({ payload, logger }) => {
    const practitioner = await findPractitioner(payload.practitionerId)
    await mailer.send(welcomeMail, { to: practitioner.email, data: { … } })
  },
})

export const geocodePractitioner = defineListener(practitionerCreated, {
  name: 'geocode-practitioner',
  load: () => import('./listeners/geocode-practitioner.js'), // loaded by workers only
})

const events = createEventBus({
  transport: createMemoryTransport(), // a real queue in production
  listeners: [sendWelcomeMail, geocodePractitioner],
})

await events.emit(practitionerCreated, { practitionerId: '42' })
```

## Concepts

| | Role | Where |
| --- | --- | --- |
| **Event** (`defineEvent`) | a fact, with a name and a payload schema | shared code |
| **Listener** (`defineListener`) | a reaction to an event, with a unique name | shared code |
| **Bus** (`createEventBus`) | validates emitted events, sends one message per listener to its transport | the code that emits (API, scripts) |
| **Transport** | sends messages to a queue: `sync`, `memory`, SQS, Redis… | bus configuration |
| **Worker** (`createWorker`) | runs the listeners of the messages it receives | Lambda, Cloudflare Worker, container, `dotpress-events work` |

`emit()` sends **one message per listener**: each listener is retried on its own, and can run on another platform than the others.

## Events

```ts
defineEvent({
  name: 'invoice.paid', // letters, digits, ".", "_", ":" and "-"
  schema: z.object({ invoiceId: z.string(), paidAt: z.iso.datetime() }),
  transport: 'edge', // optional: see Several transports
})
```

**Payloads travel as JSON.** The bus serializes the payload, then validates the result with the schema, so an invalid payload throws an `EventPayloadError` at `emit()`, not later in a worker. Describe JSON values: dates as ISO strings (convert them in the schema with `.transform()` or `z.coerce.date()` if listeners need `Date` objects). Workers validate the payload again: a message emitted by a previous version of your code is checked against the current schema.

**Pass identifiers, not secrets.** Messages are stored by queues, shown in their consoles and kept in dead-letter queues: send `{ practitionerId }`, never a password or a token. Listeners load what they need.

## Listeners

```ts
defineListener(invoicePaid, {
  name: 'send-receipt', // unique: it identifies the listener in messages
  handle: async (context) => { … },
  // or: load: () => import('./listeners/send-receipt.js'), with a default export
  transport: 'edge', // optional: another transport than its event
})
```

The handler receives:

| Field | Content |
| --- | --- |
| `payload` | the payload, parsed by the schema (transforms applied) |
| `event`, `listener` | names |
| `id` | identifier of the message: the same for every attempt |
| `emissionId` | identifier of the emission, shared by the messages of its listeners |
| `attempt` | attempt number, from 1 |
| `emittedAt` | date of the emission |
| `metadata` | metadata of the emission (`requestId` with `eventsPlugin`) |
| `logger` | logger of the worker |

**Throw to have the message retried.** The transport retries it, then moves it to its dead-letter queue (see Failures).

**Make listeners idempotent.** Queues deliver messages at least once: a message can run twice (a retry after a timeout, a duplicate delivery). Use `id` to ignore duplicates (a unique constraint, a "sent" flag), or design the listener so that running it twice is harmless.

**Renaming a listener** orphans the messages still in queues under the old name: deploy workers that handle both names first, or drain the queues.

`load` keeps the code of the listeners (database clients, SDKs…) out of the code that emits: the bus only needs the names and routes of the listeners.

## Emitting

```ts
const { emissionId, messages } = await events.emit(
  invoicePaid,
  { invoiceId: 'F-1', paidAt: new Date().toISOString() },
  {
    delay: 3600, // seconds, within the limit of the transport
    metadata: { source: 'stripe' }, // passed to the listeners
  }
)
```

`messages` lists one `{ id, listener, transport }` per listener. An event without listeners is not sent.

**Emit after the transaction commits.** An event describes something that happened: emitted inside a database transaction that rolls back, it describes something that did not. Commit first, then emit.

```ts
const practitioner = await db.transaction(async (tx) => createPractitioner(tx, input))
await events.emit(practitionerCreated, { practitionerId: practitioner.id })
```

When some messages cannot be sent (a queue is down), `emit()` throws an `EventEmitError` listing the `sent` and `failed` messages. Emitting again is safe: message ids depend on the emission and the listener, so listeners that use `id` ignore the duplicates.

## Several transports

Name the transports in the bus, and route events (or single listeners) to them. Without `transport`, an event uses `default`.

```ts
declare module '@dotpress/events' {
  interface EventTransports {
    edge: true // "transport: 'edge'" is now type-checked
  }
}

export const recordingUploaded = defineEvent({
  name: 'recording.uploaded',
  schema: z.object({ recordingId: z.string() }),
  transport: 'edge',
})

const events = createEventBus({
  transports: {
    default: createSqsTransport({ queueUrl }), // handled by a Lambda worker
    edge: createCloudflareQueueTransport({ … }), // handled by a Cloudflare worker
  },
  listeners,
})
```

The code that emits does not change: `events.emit(recordingUploaded, …)` reaches the right queue. The bus checks at startup that every listener has its transport.

## Transports

| Transport | Import | Use |
| --- | --- | --- |
| `createSyncTransport()` | `@dotpress/events` | runs the listeners inside `emit()`, which waits for them and throws an `EventEmitError` if one fails; delays are ignored. Development, tests, apps without a queue |
| `createMemoryTransport()` | `@dotpress/events` | in-process queue with retries (3 attempts, 100 ms then doubled; `maxAttempts`, `retryDelay`), `sent`, `drain()`, `clear()`. Development and tests; messages are lost when the process stops |
| `createSqsTransport()` | `@dotpress/events/sqs` | Amazon SQS (standard and FIFO queues), with a Lambda handler and a long-polling source |
| `createBullmqTransport()` | `@dotpress/events/bullmq` | Redis, through BullMQ: retries with backoff, delays, deduplication |
| `createCloudflareQueueTransport()` | `@dotpress/events/cloudflare` | Cloudflare Queues, from a Worker (binding) or from anywhere (REST API), with a `queue()` handler and an HTTP pull source |
| `createPgBossTransport()` | `@dotpress/events/pg-boss` | Postgres, through pg-boss: no other infrastructure than your database |
| `createPubSubTransport()` | `@dotpress/events/pubsub` | Google Cloud Pub/Sub, over the REST API (any runtime), with a push endpoint and a pull source |

A transport for Azure Service Bus is coming.

```ts
// Tests: emit, wait, check
const transport = createMemoryTransport({ retryDelay: () => 0 })
const events = createEventBus({ transport, listeners })
await signUp(events, 'ada@example.com')
await transport.drain()
expect(transport.sent).toMatchObject([{ event: 'user.created', listener: 'send-welcome-mail' }])
```

## Amazon SQS

```sh
pnpm add @aws-sdk/client-sqs
```

### Sending

```ts
import { createSqsTransport } from '@dotpress/events/sqs'

const events = createEventBus({
  transport: createSqsTransport({ queueUrl: process.env.EVENTS_QUEUE_URL! }),
  listeners,
})
```

Messages are sent in batches of 10 (`SendMessageBatch`), with `event` and `listener` message attributes. The client is created from the environment (region, credentials), or from `clientConfig`; pass `client` to reuse yours.

| Limit | Value |
| --- | --- |
| Message size, attributes included | 1 MiB: larger messages fail (`EventEmitError`), the others are sent |
| `delay` | 900 seconds (15 minutes) |

**FIFO queues** (URL ending with `.fifo`): messages are ordered within a message group, the listener by default (`messageGroupId: (envelope) => …` to group by entity), and deduplicated by their id for 5 minutes. They do not accept per-message delays.

### Lambda workers

```ts
import { createSqsHandler } from '@dotpress/events/sqs'

export const handler = createSqsHandler(
  createWorker({ listeners: [sendWelcomeMail, geocodePractitioner], logger }),
  {
    deadLetterQueueUrl: process.env.EVENTS_DLQ_URL, // optional, see below
    retryDelay: (attempt) => 30 * 2 ** (attempt - 1), // optional backoff, in seconds
  }
)
```

**Enable `ReportBatchItemFailures`** on the event source mapping: the handler returns the failed messages (`batchItemFailures`), so only they are retried. Without it, a failure retries the whole batch. Messages of a batch run in parallel; with a FIFO queue, in order, stopping at the first failure.

### Long-running workers

```ts
import { createSqsSource } from '@dotpress/events/sqs'

// worker.ts, for startWorker() or `dotpress-events work ./worker.ts`
export default {
  worker: createWorker({ listeners }),
  source: createSqsSource({
    queueUrl: process.env.EVENTS_QUEUE_URL!,
    visibilityTimeout: 60, // extended while a listener runs
  }),
}
```

The source reads the queue by long polling (`waitTimeSeconds`, 20 by default; `batchSize`, 10 by default), runs the messages of a batch in parallel, and deletes the handled ones. With `visibilityTimeout`, it keeps a message invisible while its listener runs (every half timeout), so that a long listener is not delivered twice. Receive errors are logged and retried, after 1 second then up to 30 seconds. At startup, it warns when the queue has no dead-letter queue.

### Retries and dead-letter queue

Configure the queue in your infrastructure:

- a **dead-letter queue**, with a redrive policy: `maxReceiveCount` is the number of attempts before a message moves there;
- a **visibility timeout** of at least 6 times the timeout of the Lambda function (AWS recommendation), or longer than your slowest listener for a long-running worker;
- for Lambda, `ReportBatchItemFailures` on the event source mapping.

A failed message becomes visible again after the visibility timeout; `retryDelay(attempt)` sets another delay (`ChangeMessageVisibility`, up to 12 hours). Set `maxAttempts` on the worker to the `maxReceiveCount` of the queue: `onFailure` then reports the last attempt as `final`.

**Messages that can never be handled** (invalid payload, unknown listener): with `deadLetterQueueUrl`, they are copied to the dead-letter queue at once, with `reason` and `error` attributes, and deleted from the queue. Without it, they fail until `maxReceiveCount`, like other failures.

```ts
// AWS CDK
const dlq = new sqs.Queue(this, 'EventsDlq', { retentionPeriod: Duration.days(14) })
const queue = new sqs.Queue(this, 'Events', {
  visibilityTimeout: Duration.seconds(180), // 6 × the timeout of the function
  deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
})
worker.addEventSource(
  new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true })
)
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

**IAM permissions**: `sqs:SendMessage` for the code that emits; for workers, `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes` (granted by the Lambda event source mapping, or yours for a long-running worker), `sqs:ChangeMessageVisibility` with `retryDelay` or `visibilityTimeout`, and `sqs:SendMessage` on the dead-letter queue with `deadLetterQueueUrl`.

## Redis (BullMQ)

```sh
pnpm add bullmq ioredis
```

```ts
import { createBullmqSource, createBullmqTransport } from '@dotpress/events/bullmq'

const connection = { host: 'localhost', port: 6379 }

// The code that emits
const transport = createBullmqTransport({ name: 'events', connection })
const events = createEventBus({ transport, listeners })
// On shutdown: await transport.close()

// worker.ts, for startWorker() or `dotpress-events work ./worker.ts`
export default {
  worker: createWorker({ listeners, maxAttempts: 3 }),
  source: createBullmqSource({ name: 'events', connection, concurrency: 5 }),
}
```

Each message becomes a [BullMQ](https://docs.bullmq.io) job named after its listener, with the message id as job id: emitting again adds no duplicate while the job exists. `delay` has no upper limit.

**Job options** (`jobOptions`, merged with the defaults): 3 `attempts`, `exponential` backoff from 1 second, completed jobs removed (`removeOnComplete: true`), failed jobs kept (`removeOnFail: false`). Set `maxAttempts` of the worker to the same number of attempts, so that `onFailure` reports the last one as `final`.

**Failed jobs are the dead-letter queue**: after their last attempt, jobs stay in the failed set of the queue, with their error, where you can inspect and retry them (BullMQ API, or a dashboard such as Bull Board). Messages that can never be handled (invalid payload, unknown listener) fail at once, without retries (`UnrecoverableError`).

**Source**: `concurrency` jobs at a time (1 by default). On stop, the source waits for the jobs in progress, up to `closeTimeout` (30 seconds by default); their jobs then become stalled and another worker retries them. While Redis is unreachable, BullMQ cannot close: the stop gives up waiting after `closeTimeout`, and BullMQ may keep reconnecting until the process exits.

**Redis requirements** (BullMQ): Redis 6.2 or later, with `maxmemory-policy=noeviction`. Use `prefix` for the key prefix, not the `keyPrefix` of ioredis. An ioredis instance passed as `connection` to a source needs `maxRetriesPerRequest: null`. Pass `queue` instead of `name` and `connection` to reuse a `Queue` (shared connection, another BullMQ backend).

BullMQ runs on Node.js and Bun.

## Cloudflare Queues

No dependency: the transport uses the queue binding inside Workers, and `fetch` elsewhere.

```jsonc
// wrangler.jsonc
{
  "queues": {
    "producers": [{ "queue": "events", "binding": "EVENTS_QUEUE" }],
    "consumers": [
      {
        "queue": "events",
        "max_batch_size": 10,
        "max_retries": 5,
        "dead_letter_queue": "events-dlq"
      }
    ]
  }
}
```

### Sending

```ts
import { createCloudflareQueueTransport } from '@dotpress/events/cloudflare'

// Inside a Worker: the producer binding
import { env } from 'cloudflare:workers'
const transport = createCloudflareQueueTransport({ queue: () => env.EVENTS_QUEUE })

// Anywhere else (Node.js, Lambda…): the REST API
const transport = createCloudflareQueueTransport({
  accountId: process.env.CF_ACCOUNT_ID!,
  queueId: process.env.CF_QUEUE_ID!, // the queue ID, not its name
  apiToken: process.env.CF_API_TOKEN!, // Queues Write permission
})
```

`queue` also accepts the binding itself. Messages are sent as JSON, in batches of 100 messages and 256 KB at most.

| Limit | Value |
| --- | --- |
| Message size | 128 KB, including about 100 bytes of metadata: larger messages fail (`EventEmitError`) |
| `delay` | 86,400 seconds (24 hours) |

### Worker consumers

```ts
import { createCloudflareQueueHandler } from '@dotpress/events/cloudflare'

export default {
  queue: createCloudflareQueueHandler(createWorker({ listeners, maxAttempts: 5 }), {
    retryDelay: (attempt) => 30 * attempt, // optional, in seconds
    deadLetterQueue: () => env.EVENTS_DLQ, // optional producer binding, see below
  }),
}
```

Each message is acknowledged (`ack()`) or retried (`retry()`) on its own: a failure does not retry the whole batch. After `max_retries`, Cloudflare moves the message to the `dead_letter_queue` of the consumer (without it, the message is deleted). Set `maxAttempts` of the worker to `max_retries + 1`.

**Messages that can never be handled**: with `deadLetterQueue` (a producer binding to the dead-letter queue), they are sent there at once and acknowledged. Without it, they are retried until `max_retries`.

### Pull consumers

To run workers outside Cloudflare (a container, your machine with `dotpress-events work`), enable an HTTP pull consumer on the queue (`wrangler queues consumer http add events`; a queue has either a Worker consumer or a pull consumer):

```ts
import { createCloudflarePullSource } from '@dotpress/events/cloudflare'

export default {
  worker: createWorker({ listeners }),
  source: createCloudflarePullSource({
    accountId,
    queueId,
    apiToken, // Queues Read and Write permissions
    visibilityTimeoutMs: 60_000, // lease: longer than your slowest listener
    deadLetterQueueId, // optional: dead messages are pushed there at once
  }),
}
```

The source pulls `batchSize` messages (10 by default, up to 100), runs them in parallel, then acknowledges or retries them in one request. The API cannot extend a lease: set `visibilityTimeoutMs` (30 seconds by default, up to 12 hours) above the duration of your slowest listener, or the message is delivered again while it runs. An empty queue is pulled again after `pollInterval` (1 second by default). Errors are logged and retried, after 1 second then up to 30 seconds.

## Postgres (pg-boss)

```sh
pnpm add pg-boss
```

```ts
import { createPgBossSource, createPgBossTransport } from '@dotpress/events/pg-boss'

const boss = process.env.DATABASE_URL! // or pg-boss options, or a started instance
const queueOptions = { deadLetter: 'events-dlq' } // optional

// The code that emits
const transport = createPgBossTransport({ boss, queue: 'events', queueOptions })
const events = createEventBus({ transport, listeners })
// On shutdown: await transport.close()

// worker.ts, for startWorker() or `dotpress-events work ./worker.ts`
export default {
  worker: createWorker({ listeners, maxAttempts: 3 }),
  source: createPgBossSource({ boss, queue: 'events', queueOptions, batchSize: 5 }),
}
```

[pg-boss](https://pgboss.io) keeps the queue in your Postgres database (13 or later; pg-boss needs Node.js 22.12 or later, or Bun). With a connection string or options, the transport and the source create and start their own pg-boss instance (`close()` stops the one of the transport); pass a started instance to share it.

**Queues** are created on first use when they do not exist, with `queueOptions` merged with the defaults: 3 attempts (`retryLimit: 2`), exponential backoff from 1 second (`retryDelay: 1`, `retryBackoff: true`). Existing queues are not changed. With `deadLetter`, the dead-letter queue is created too: failed jobs go there after their last attempt, and messages that can never be handled at once. Set `maxAttempts` of the worker to `retryLimit + 1`.

Each message is a job whose id is the message id: emitting again is ignored by pg-boss, which keeps the first job. `delay` has no upper limit.

**Source**: `batchSize` jobs at a time (1 by default), handled in parallel, each with its own result (`perJobResults`): one failure does not retry the others. `pollingIntervalSeconds` sets the wait on an empty queue (0.5 at least). On stop, the source waits for the jobs in progress, up to `closeTimeout` (30 seconds by default). pg-boss errors are logged.

Emit after the transaction commits, as with the other transports: an event emitted inside a transaction that rolls back describes something that did not happen.

## Google Cloud Pub/Sub

```sh
pnpm add google-auth-library  # to publish with Application Default Credentials
pnpm add jose                 # push endpoints: to verify the tokens
pnpm add @google-cloud/pubsub # pull workers
```

Each of these is optional: install only what you use.

### Sending

```ts
import { createPubSubTransport } from '@dotpress/events/pubsub'

const transport = createPubSubTransport({ topic: 'projects/my-project/topics/events' })
```

The transport publishes over the REST API with `fetch`: it runs on Node.js, Bun, Deno and Cloudflare Workers. Each message carries the attributes `event` and `listener`; a subscription can filter on them (`--message-filter='attributes.listener = "send-welcome-mail"'`) to run some listeners on other workers.

**Authentication**: by default, an OAuth token from Application Default Credentials, through `google-auth-library` (the service account of Cloud Run, GKE or Cloud Functions, `GOOGLE_APPLICATION_CREDENTIALS`, or `gcloud auth application-default login`). The account needs the Pub/Sub Publisher role (`roles/pubsub.publisher`) on the topic. Elsewhere, pass `getAccessToken`, which returns a token with the `https://www.googleapis.com/auth/pubsub` scope. For the emulator: `baseUrl: 'http://localhost:8085', getAccessToken: false`.

| Limit | Value |
| --- | --- |
| Request | 10 MB and 1,000 messages: larger emissions are split into several requests |
| Message size | 10 MB with the base64-encoded envelope (about 7.5 MB of JSON): larger messages fail (`EventEmitError`) |
| `delay` | not supported by Pub/Sub: an emission with a delay fails (`EventEmitError`, `RangeError`) |

### Subscriptions, retries and dead letters

Subscriptions are your infrastructure. Pub/Sub delivers each message at least once: use `context.id` to ignore duplicates.

```sh
gcloud pubsub topics create events
gcloud pubsub topics create events-dlq
gcloud pubsub subscriptions create events-worker --topic=events \
  --ack-deadline=60 \
  --min-retry-delay=10s --max-retry-delay=600s \
  --dead-letter-topic=events-dlq --max-delivery-attempts=5
```

With a dead-letter policy, Pub/Sub counts the delivery attempts, and moves the message to the dead-letter topic after `--max-delivery-attempts` (5 to 100); its service account needs the Publisher role on the dead-letter topic and the Subscriber role on the subscription. Set `maxAttempts` of the worker to `--max-delivery-attempts`. Without a dead-letter policy, every delivery counts as the first attempt, and a failing message is delivered again until the retention of the subscription expires (7 days by default).

**Messages that can never be handled** (not an envelope, unknown listener, invalid payload): with the `deadLetter` option of the push handler or `deadLetterTopic` of the pull source, they are published at once to that topic, with the attributes `reason` and `error`, and acknowledged. Without it, they are delivered again until the dead-letter policy moves them.

### Push endpoints

A push subscription POSTs each message to your endpoint, with an OIDC token signed by Google:

```sh
gcloud pubsub subscriptions create events-push --topic=events \
  --push-endpoint=https://api.example.com/pubsub \
  --push-auth-service-account=pubsub-push@my-project.iam.gserviceaccount.com \
  --ack-deadline=60 \
  --dead-letter-topic=events-dlq --max-delivery-attempts=5
```

```ts
import { createPubSubPushHandler } from '@dotpress/events/pubsub'

const push = createPubSubPushHandler(createWorker({ listeners, maxAttempts: 5 }), {
  audience: 'https://api.example.com/pubsub', // the push endpoint, or --push-auth-token-audience
  serviceAccountEmail: 'pubsub-push@my-project.iam.gserviceaccount.com',
  deadLetter: { topic: 'projects/my-project/topics/events-dlq' }, // optional, see above
})

// Web-standard runtimes (Cloudflare Workers, Hono, Bun, Deno)
app.post('/pubsub', (c) => push.fetch(c.req.raw))
// Other frameworks: the parsed JSON body and the Authorization header
app.post('/pubsub', async (req, res) => {
  res.status(await push.handle(req.body, req.headers.authorization)).end()
})
```

The handler verifies the token with `jose`: signature with the Google keys, issuer, `audience`, a verified `email`, equal to `serviceAccountEmail` when set. It answers 204 when the message is handled (or moved to `deadLetter`), and 503 to have it delivered again; 401 and 403 for invalid tokens, 400 for bodies that are not push messages (Pub/Sub delivers these again too). Set `verifyToken: false` only behind a proxy that checks the token. Pub/Sub waits for the answer up to the ack deadline of the subscription (10 seconds by default, up to 600): set it above your slowest listener.

### Pull workers

```ts
import { createPubSubPullSource } from '@dotpress/events/pubsub'

// worker.ts, for startWorker() or `dotpress-events work ./worker.ts`
export default {
  worker: createWorker({ listeners, maxAttempts: 5 }),
  source: createPubSubPullSource({
    subscription: 'projects/my-project/subscriptions/events-worker',
    maxMessages: 10, // messages handled at the same time (default)
    deadLetterTopic: 'projects/my-project/topics/events-dlq', // optional, see above
  }),
}
```

The source uses the streaming pull of `@google-cloud/pubsub` (Node.js), which extends the ack deadline of the messages in progress. Credentials come from Application Default Credentials, `clientConfig` (options of `new PubSub()`), or the `client` you pass; the client uses the emulator when `PUBSUB_EMULATOR_HOST` is set. On stop, the source waits for the messages in progress, up to `closeTimeout` (30 seconds by default). Subscription errors are logged.

## Workers

A worker runs the listeners of the messages it receives. Give it the listeners it is responsible for:

```ts
const worker = createWorker({
  listeners: [sendWelcomeMail, geocodePractitioner],
  logger,
  onFailure: (error, { envelope, attempt, final, reason }) => { … },
  maxAttempts: 5, // the retry limit of the queue, to report the last attempt as final
})
```

Each transport provides the entry points of its platforms (a Lambda handler, a Cloudflare `queue()` handler…), built on `worker.handle(message, { attempt })`. It returns `success`, `retry` (the listener threw) or `dead` (the message can never be handled), and never throws.

### Long-running workers

`startWorker(worker, source)` reads messages from a queue until stopped: in a container, a VM, or locally.

```ts
const running = startWorker(worker, source, { logger, signal })
await running.stop() // finishes the messages in progress
```

### `dotpress-events work`

Like `queue:work` in Laravel: runs a worker next to your app, until Ctrl+C.

```sh
npx dotpress-events work ./src/events/worker.ts
npx dotpress-events work ./src/events/worker.ts --watch # restarts when a file changes
```

The module exports `{ worker, source }` (and optionally a `logger`), or a function returning them; choose another export with `--export`. Logs are written to the standard error as JSON lines. With an SQS transport, it reads your development queue as the Lambda would, without deploying; in production, it is also the entry point of a container.

TypeScript modules require Node.js 22.18 or later (erasable syntax, relative imports ending in `.ts`); otherwise, run the compiled module, or the command with `NODE_OPTIONS="--import tsx"`.

## Failures

| Failure | What happens |
| --- | --- |
| The listener throws | `retry`: the transport delivers the message again, then moves it to its dead-letter queue after its retry limit |
| Invalid payload, unknown listener, not an envelope | `dead`: retrying would not help. The message goes to the dead-letter queue when the transport can send it there directly; otherwise it fails until the retry limit |

`onFailure(error, info)` is called for every failure, with the `envelope` (undefined when the message is not one), the `reason` (`listener-error`, `invalid-envelope`, `unknown-listener`, `invalid-payload`), the `attempt`, and `final` (dead message, or last attempt with `maxAttempts`). Use it for alerts; its own errors are logged and ignored.

**Dead-letter queues are part of your infrastructure** (CDK, Terraform, Wrangler…), not created by this package: each transport documents the configuration it expects.

An unknown listener usually means a deployment mistake: a listener routed to a queue whose workers do not run it. Check the logs of your workers after adding a listener.

## Dotpress plugin

```ts
import { eventsPlugin } from '@dotpress/events/plugin'

await createApp({ adapter, plugins: [eventsPlugin(events)] })

defineRoute({
  method: 'post',
  path: '/practitioners',
  handler: async ({ events, body }) => {
    const practitioner = await createPractitioner(body)
    await events.emit(practitionerCreated, { practitionerId: practitioner.id })
    return practitioner
  },
})
```

`ctx.events` logs with the request logger, and adds the request ID to the metadata of the emitted events (`requestId`): listeners can link their logs to the request. Using `ctx.events` without the plugin throws an explicit error. `events.withContext({ logger, metadata })` does the same outside Dotpress.

## Logs

With a `logger` (a Dotpress or Pino logger, or any object with `info`, `warn` and `error` methods, and optionally `debug`):

| Level | Message |
| --- | --- |
| `info` | `Event emitted` (event, emission id, number of messages); `Event worker started` / `stopped` |
| `debug` | `Event emitted without listeners`; `Event listener succeeded` |
| `warn` | `Event listener failed, the message is retried` |
| `error` | `Event listener failed, the message is not retried`; `onFailure hook failed` |

Payloads are not logged.

## Errors

| Error | When |
| --- | --- |
| `TypeError` | invalid options of `defineEvent()`, `defineListener()`, `createEventBus()`, `emit()`… |
| `EventPayloadError` | the payload does not match the schema, or is not serializable as JSON (`event`, `issues`) |
| `EventEmitError` | some messages could not be sent (`sent`, `failed`, `cause`) |
| `PartialSendError` | for transport authors: some messages of a `send()` call failed |

The error classes extend `EventsError`.

## Custom transports

A transport has a `kind` and a `send(envelopes, { delay })` method; a source has a `kind` and a `consume(worker, { signal, logger })` method. Envelopes are plain JSON objects: `{ v: 1, id, emissionId, event, listener, payload, emittedAt, metadata }`.

## License

MIT
