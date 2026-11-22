---
'@dotpress/events': minor
---

`createEventBus()` takes a `sendTimeout`, 10 seconds by default: how long `emit()` waits for a transport. A queue that cannot be reached made `emit()` wait without limit, such as BullMQ while Redis was down, and the request waited with it. Beyond the timeout, the messages of the transport fail with an `EventSendTimeoutError`, in the `EventEmitError` that `retry()` sends again. `false` waits without limit; the `sync` and `memory` transports are not limited. Transports receive an abort `signal` in `send()`, which the SQS transport passes to its client.

The BullMQ documentation and examples no longer set `maxRetriesPerRequest: null` on the transport, which made its commands wait for Redis without limit, and set `enableOfflineQueue: false` so that `emit()` fails at once during an outage.
