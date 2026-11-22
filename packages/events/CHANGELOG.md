# @dotpress/events

## 2.0.0-beta.0

### Patch Changes

- [#42](https://github.com/dotpressjs/dotpress/pull/42) [`3c7b664`](https://github.com/dotpressjs/dotpress/commit/3c7b6649c2ff5482c9be3bb40d2cf7780c1afed4) Thanks [@renoguyon](https://github.com/renoguyon)! - First beta of Dotpress 2. The API is complete: until 2.0.0, it changes only from feedback, and each change is listed in this changelog. `@dotpress/auth` is installed with the `beta` tag (without a tag, npm installs the 1.x).
- Updated dependencies [[`3c7b664`](https://github.com/dotpressjs/dotpress/commit/3c7b6649c2ff5482c9be3bb40d2cf7780c1afed4)]:
  - @dotpress/core@2.0.0-beta.0

## 2.0.0-alpha.8

### Minor Changes

- [#39](https://github.com/dotpressjs/dotpress/pull/39) [`b6c1f7d`](https://github.com/dotpressjs/dotpress/commit/b6c1f7d305acba3c62467d58c5caef63d50304f5) Thanks [@renoguyon](https://github.com/renoguyon)! - `createEventBus()` takes a `sendTimeout`, 10 seconds by default: how long `emit()` waits for a transport. A queue that cannot be reached made `emit()` wait without limit, such as BullMQ while Redis was down, and the request waited with it. Beyond the timeout, the messages of the transport fail with an `EventSendTimeoutError`, in the `EventEmitError` that `retry()` sends again. `false` waits without limit; the `sync` and `memory` transports are not limited. Transports receive an abort `signal` in `send()`, which the SQS transport passes to its client.
  
  The BullMQ documentation and examples no longer set `maxRetriesPerRequest: null` on the transport, which made its commands wait for Redis without limit, and set `enableOfflineQueue: false` so that `emit()` fails at once during an outage.

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.8

## 2.0.0-alpha.7

### Minor Changes

- [#35](https://github.com/dotpressjs/dotpress/pull/35) [`112b41c`](https://github.com/dotpressjs/dotpress/commit/112b41cfca3bd4918400f097e8d89856569180a4) Thanks [@renoguyon](https://github.com/renoguyon)! - Workers and queue handlers log to the console by default, from the `info` level: `createWorker()`, `startWorker()`, `createSqsHandler()`, `createPubSubHandler()`, `createServiceBusHandler()` and `createCloudflareQueueHandler()`. They were silent without a `logger`, so a failing listener left no trace. The event bus stays silent by default: in an app, it logs with the request logger. `createPubSubHandler()` now checks its `logger` option.

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.7

## 2.0.0-alpha.6

### Patch Changes

- Updated dependencies [[`eacaf1c`](https://github.com/dotpressjs/dotpress/commit/eacaf1ce2c9168b46c103d89773cade65ed5650e)]:
  - @dotpress/core@2.0.0-alpha.6

## 2.0.0-alpha.5

### Minor Changes

- [#21](https://github.com/dotpressjs/dotpress/pull/21) [`dee65c4`](https://github.com/dotpressjs/dotpress/commit/dee65c4110cc78af4c29cc079920eb22c618167d) Thanks [@renoguyon](https://github.com/renoguyon)! - API review of the events package, before the beta. Breaking changes:
  
  - Durations are `Duration` values, without unit in their names: a number of seconds, or a string like `'500ms'`, `'30s'` or `'5m'`. `emit({ delay })` (rounded up to the second), SQS `waitTime` (was `waitTimeSeconds`) and `visibilityTimeout`, Cloudflare `visibilityTimeout` (was `visibilityTimeoutMs`, in milliseconds) and `pollInterval` (in milliseconds before), pg-boss `pollInterval` (was `pollingIntervalSeconds`), `closeTimeout` (in milliseconds before), Service Bus `maxLockRenewal` (was `maxAutoLockRenewalDurationInMs`). `retryDelay(attempt)` returns a `Duration` everywhere: the memory transport read milliseconds.
  - Messages handled at once are `concurrency` on every source: it replaces `batchSize` (SQS, Cloudflare, pg-boss), `maxMessages` (Pub/Sub) and `maxConcurrentCalls` (Service Bus). The BullMQ queue is `queue`, like elsewhere (was `name`).
  - The dead-letter destination is `deadLetter` everywhere: the queue URL for SQS (was `deadLetterQueueUrl`), the queue ID for the Cloudflare source (was `deadLetterQueueId`), the binding for the Cloudflare handler (was `deadLetterQueue`), `{ topic }` for the Pub/Sub source (was `deadLetterTopic`).
  - Factories follow `create<Provider>{Transport,Source,Handler}`: `createCloudflareQueueSource` (was `createCloudflarePullSource`), `createPubSubSource` (was `createPubSubPullSource`), `createPubSubHandler` (was `createPubSubPushHandler`), `createServiceBusHandler` (was `createServiceBusFunctionHandler`), and their option types.
  - An envelope of a later version is retried (`unsupported-version`, a new `RetryReason`) instead of being sent to the dead-letter queue, so that a rolling deployment loses no message.
  - `Transport` has an optional `close()`, and the bus a `close()` that closes every transport once: `eventsPlugin()` calls it when the app closes. `bind()` and `maxAttempts` are no longer part of `Transport`.
  - Internal helpers are no longer exported: `processorOf`, `handlerOf`, `queueUrlOf`, `decodePulledBody`, `parseEnvelope`, `DEFAULT_JOB_OPTIONS` and `DEFAULT_QUEUE_OPTIONS`.
  - The Cloudflare and Service Bus handlers take a `logger`. `WorkerEntry`, `EventOptions`, `RetryReason` and `Duration` (the same type as in `@dotpress/core`, which is optional here) are exported. The memory transport rejects unknown options.

### Patch Changes

- [#23](https://github.com/dotpressjs/dotpress/pull/23) [`7a5edeb`](https://github.com/dotpressjs/dotpress/commit/7a5edeba1d104850a528ffd05909e766332694a4) Thanks [@renoguyon](https://github.com/renoguyon)! - Last lot of the API review, before the beta. Breaking changes:
  
  - One verb per operation: `api.addRoute()` becomes `api.defineRoute()`, `api.addRouteGroup()` becomes `api.createGroup()`, and the global `registerResponseFilter()` becomes `addResponseFilter()`, like the methods of routers and plugins.
  - `RouteResponse` becomes `DocumentedResponse`, and `SchemaDefinition`, `SchemaInput` and `SchemaOutput` become `RouteSchemaDefinition`, `RouteSchemaInput` and `RouteSchemaOutput`.
  - `app.listen()` and `HttpAdapter.listen()` return the address of the server, `{ port, host }`: the actual port with `listen(0)`.
  - `redirect(location, { status, headers })` takes an options object, and checks the status.
  - The `origin` function of the `cors` option and `generateRequestId` receive the request of the app (`DotpressRequest`, with `header()`), not the normalized request of the adapter.
  - `RouteMeta.tags` and `security` accept readonly arrays (`as const`).
  - The options of the adapters have a default type parameter (`HonoAdapterOptions` is `HonoAdapterOptions<Hono>`), and the Fastify adapter refuses to listen twice.
  - `@dotpress/testing` exports the types of its signatures: `EnvelopeLike`, `SentMailAddress` and `ExpectedAddresses`.
  
  The error messages of the configuration follow one format, `fn(): message.`, or the subject they are about (`Route "/users": …`).
- Updated dependencies [[`7a5edeb`](https://github.com/dotpressjs/dotpress/commit/7a5edeba1d104850a528ffd05909e766332694a4), [`7c669aa`](https://github.com/dotpressjs/dotpress/commit/7c669aa7398a66d01176819417eb41cb38110a48)]:
  - @dotpress/core@2.0.0-alpha.5

## 2.0.0-alpha.4

### Minor Changes

- [#14](https://github.com/dotpressjs/dotpress/pull/14) [`bf496ad`](https://github.com/dotpressjs/dotpress/commit/bf496ad1f51a875c07502f9075c04ad536c5d338) Thanks [@renoguyon](https://github.com/renoguyon)! - `emit()` accepts an `emissionId` option: the message ids derive from it, so emitting again with the same `emissionId` gives the same ids, and listeners can ignore the duplicates. `EventEmitError#retry()` sends again only the messages that failed, with the same ids, delay and metadata; a new failure throws a new `EventEmitError` whose `sent` adds up the attempts. `createFakeEventBus()` records the given `emissionId`.

### Patch Changes

- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.4

## 2.0.0-alpha.3

### Patch Changes

- [#13](https://github.com/dotpressjs/dotpress/pull/13) [`a79013c`](https://github.com/dotpressjs/dotpress/commit/a79013cb57792ac4df83d76b28c72279b04e12fe) Thanks [@renoguyon](https://github.com/renoguyon)! - Faster Pub/Sub publishing of large messages: base64 encoding uses `Uint8Array#toBase64` when the runtime has it, and encodes by chunks otherwise. A message of several megabytes took about a second of CPU, blocking the event loop.

- [#7](https://github.com/dotpressjs/dotpress/pull/7) [`9432ce3`](https://github.com/dotpressjs/dotpress/commit/9432ce318a55287ce2431837075162743dd2389b) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: each package describes itself with an example, and links to its pages on the documentation site, dotpress.dev, which holds the guides and the reference.
- Updated dependencies [[`9432ce3`](https://github.com/dotpressjs/dotpress/commit/9432ce318a55287ce2431837075162743dd2389b)]:
  - @dotpress/core@2.0.0-alpha.3

## 2.0.0-alpha.2

### Patch Changes

- [#2](https://github.com/dotpressjs/dotpress/pull/2) [`5128817`](https://github.com/dotpressjs/dotpress/commit/5128817d0975df4797b31a0b4c4edf4c55c4cb56) Thanks [@renoguyon](https://github.com/renoguyon)! - `dotpress-events work`: Ctrl+C stops the worker after the messages in progress, also through `npm run`, `pnpm run` and `--watch`, which relay the signal: the repeats of a signal within one second are the same stop request, and a signal sent again a second later or more exits at once. With `--watch`, a signal sent to the command only (`kill`, the stop button of an IDE) now stops the worker, instead of leaving it running.
- Updated dependencies []:
  - @dotpress/core@2.0.0-alpha.2

## 2.0.0-alpha.1

### Patch Changes

- [`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4) Thanks [@renoguyon](https://github.com/renoguyon)! - READMEs: Dotpress V2 is published as an alpha. Until 2.0.0, install `@dotpress/auth` with the `alpha` tag (`pnpm add @dotpress/auth@alpha`): without it, `@dotpress/auth` is the 1.x.
- Updated dependencies [[`70a2f39`](https://github.com/dotpressjs/dotpress/commit/70a2f398dc1d3d7e1986237b2288612e5f595bd4)]:
  - @dotpress/core@2.0.0-alpha.1
