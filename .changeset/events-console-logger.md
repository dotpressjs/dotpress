---
'@dotpress/events': minor
---

Workers and queue handlers log to the console by default, from the `info` level: `createWorker()`, `startWorker()`, `createSqsHandler()`, `createPubSubHandler()`, `createServiceBusHandler()` and `createCloudflareQueueHandler()`. They were silent without a `logger`, so a failing listener left no trace. The event bus stays silent by default: in an app, it logs with the request logger. `createPubSubHandler()` now checks its `logger` option.
