---
'@dotpress/events': minor
---

`emit()` accepts an `emissionId` option: the message ids derive from it, so emitting again with the same `emissionId` gives the same ids, and listeners can ignore the duplicates. `EventEmitError#retry()` sends again only the messages that failed, with the same ids, delay and metadata; a new failure throws a new `EventEmitError` whose `sent` adds up the attempts. `createFakeEventBus()` records the given `emissionId`.
