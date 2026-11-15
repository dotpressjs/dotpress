---
'@dotpress/events': minor
---

API review of the events package, before the beta. Breaking changes:

- Durations are `Duration` values, without unit in their names: a number of seconds, or a string like `'500ms'`, `'30s'` or `'5m'`. `emit({ delay })` (rounded up to the second), SQS `waitTime` (was `waitTimeSeconds`) and `visibilityTimeout`, Cloudflare `visibilityTimeout` (was `visibilityTimeoutMs`, in milliseconds) and `pollInterval` (in milliseconds before), pg-boss `pollInterval` (was `pollingIntervalSeconds`), `closeTimeout` (in milliseconds before), Service Bus `maxLockRenewal` (was `maxAutoLockRenewalDurationInMs`). `retryDelay(attempt)` returns a `Duration` everywhere: the memory transport read milliseconds.
- Messages handled at once are `concurrency` on every source: it replaces `batchSize` (SQS, Cloudflare, pg-boss), `maxMessages` (Pub/Sub) and `maxConcurrentCalls` (Service Bus). The BullMQ queue is `queue`, like elsewhere (was `name`).
- The dead-letter destination is `deadLetter` everywhere: the queue URL for SQS (was `deadLetterQueueUrl`), the queue ID for the Cloudflare source (was `deadLetterQueueId`), the binding for the Cloudflare handler (was `deadLetterQueue`), `{ topic }` for the Pub/Sub source (was `deadLetterTopic`).
- Factories follow `create<Provider>{Transport,Source,Handler}`: `createCloudflareQueueSource` (was `createCloudflarePullSource`), `createPubSubSource` (was `createPubSubPullSource`), `createPubSubHandler` (was `createPubSubPushHandler`), `createServiceBusHandler` (was `createServiceBusFunctionHandler`), and their option types.
- An envelope of a later version is retried (`unsupported-version`, a new `RetryReason`) instead of being sent to the dead-letter queue, so that a rolling deployment loses no message.
- `Transport` has an optional `close()`, and the bus a `close()` that closes every transport once: `eventsPlugin()` calls it when the app closes. `bind()` and `maxAttempts` are no longer part of `Transport`.
- Internal helpers are no longer exported: `processorOf`, `handlerOf`, `queueUrlOf`, `decodePulledBody`, `parseEnvelope`, `DEFAULT_JOB_OPTIONS` and `DEFAULT_QUEUE_OPTIONS`.
- The Cloudflare and Service Bus handlers take a `logger`. `WorkerEntry`, `EventOptions`, `RetryReason` and `Duration` (the same type as in `@dotpress/core`, which is optional here) are exported. The memory transport rejects unknown options.
