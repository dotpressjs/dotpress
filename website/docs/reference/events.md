# Events

The definitions, options, errors and contracts of `@dotpress/events`. For a guide, see [Events and workers](/services/events); for each queue, [Event workers](/deployment/event-workers).

## defineEvent()

```ts
defineEvent({ name: 'invoice.paid', schema: z.object({ invoiceId: z.string() }), transport: 'edge' })
```

| Option | Description |
| --- | --- |
| `name` | Letters, digits, `.`, `_`, `:` and `-`. |
| `schema` | Zod schema of the payload. The payload is serialized as JSON, then validated: describe JSON values. |
| `transport` | Optional: the name of a transport of the bus, `default` otherwise. |

## defineListener()

```ts
defineListener(invoicePaid, { name: 'send-receipt', handle: async (context) => { … } })
defineListener(invoicePaid, { name: 'send-receipt', load: () => import('./send-receipt.ts') })
```

| Option | Description |
| --- | --- |
| `name` | Unique: it identifies the listener in the messages. Renaming it orphans the messages still in queues. |
| `handle` | The handler. |
| `load` | Instead of `handle`: imports a module whose default export is the handler, in the workers only. |
| `transport` | Optional: another transport than the one of its event. |

The handler receives:

| Field | Description |
| --- | --- |
| `payload` | The payload, parsed by the schema, transforms applied. |
| `event`, `listener` | The names. |
| `id` | The message: the same for every attempt. Use it to ignore duplicates. |
| `emissionId` | The emission, shared by the messages of its listeners. |
| `attempt` | The attempt number, from 1. |
| `emittedAt` | The date of the emission. |
| `metadata` | The metadata of the emission: `requestId` with the plugin. |
| `logger` | The logger of the worker. |

A handler throws to be retried.

## createEventBus()

| Option | Description |
| --- | --- |
| `listeners` | Every listener of the app: the bus sends one message per listener of an emitted event. |
| `transport` | The transport of every event. |
| `transports` | Instead of `transport`: transports by name, `default` for the events without `transport`. |
| `logger` | Any logger with `info`, `warn` and `error`, and optionally `debug`. Silent by default. |
| `onFailure` | Failures of the listeners run by the `sync` and `memory` transports. |

The bus checks at startup that every listener has its transport. Names other than `default` are declared for type checking:

```ts
declare module '@dotpress/events' {
  interface EventTransports {
    edge: true
  }
}
```

### emit()

```ts
const { emissionId, messages } = await events.emit(event, payload, { emissionId, delay, metadata })
```

| Option | Description |
| --- | --- |
| `emissionId` | The identifier of the emission, random by default: the message ids derive from it. Emitting again with the same `emissionId` gives the same ids. It names one occurrence of the fact (`${order.id}:${order.version}`), not its entity. 1 to 200 characters, without control characters. |
| `delay` | Seconds before the listeners run, within the limit of the transport. |
| `metadata` | Strings passed to the listeners. Keys: 1 to 128 characters among letters, digits, `.`, `_` and `-`; values on one line. |

`messages` lists one `{ id, listener, transport }` per listener. An event without listeners is not sent. Without `emissionId`, each call is a new emission, with new message ids: emitting again after an `EventEmitError` runs again the listeners whose message was sent. `error.retry()` sends only the failed messages.

`events.withContext({ logger, metadata })` returns a bus that logs with this logger and adds this metadata: `ctx.events` is one.

## Transports in the process

| Transport | Behavior |
| --- | --- |
| `createSyncTransport()` | Runs the listeners inside `emit()`, which waits for them and throws an `EventEmitError` when one fails. Delays are ignored. |
| `createMemoryTransport(options?)` | An in-process queue with retries. Messages are lost when the process stops. |

| Option of the memory transport | Default | Description |
| --- | --- | --- |
| `maxAttempts` | `3` | Attempts of a message. |
| `retryDelay(attempt)` | 100 ms, doubled each attempt | Delay before a retry, in milliseconds. `() => 0` in tests. |

The memory transport has `sent` (the envelopes sent), `drain()` (waits for every message, retries included) and `clear()`.

`createFakeEventBus()` checks each emission like a real bus (event, payload, delay, metadata) without running listeners, and records it in `emitted`; `clear()` empties it. See [Testing helpers](/services/testing#events).

## createWorker()

| Option | Description |
| --- | --- |
| `listeners` | The listeners this worker runs. |
| `logger` | The logger of the worker, given to the listeners. |
| `onFailure(error, info)` | Called for every failure. Its own errors are logged and ignored. |
| `maxAttempts` | The retry limit of the queue, so that the last attempt is reported as `final`. |

`info` holds the `envelope` (undefined when the message is not one), the `attempt`, `final` (a dead message, or the last attempt), and the `reason`:

| Reason | Result | Meaning |
| --- | --- | --- |
| `listener-error` | `retry` | The listener threw. |
| `invalid-envelope` | `dead` | The message is not an envelope of Dotpress. |
| `unknown-listener` | `dead` | The worker does not run this listener: usually a deployment mistake. |
| `invalid-payload` | `dead` | The payload does not match the current schema of the event. |

`worker.handle(message, { attempt })` returns `success`, `retry` or `dead`, and never throws: the entry points of the transports (Lambda handler, `queue()` handler…) are built on it.

`startWorker(worker, source, { logger, signal })` reads a source until stopped, and returns `{ stop() }`, which finishes the messages in progress.

## eventsPlugin()

```ts
import { eventsPlugin } from '@dotpress/events/plugin'

await createApp({ adapter, plugins: [eventsPlugin(events)] })
```

The plugin, named `events`, provides `ctx.events`: the bus, with the request logger, and the `requestId` in the metadata. Using `ctx.events` without the plugin throws an explicit error.

## Logs

| Level | Message |
| --- | --- |
| `info` | `Event emitted` (event, emission id, number of messages); `Event worker started`, `Event worker stopped` |
| `debug` | `Event emitted without listeners`; `Event listener succeeded` |
| `warn` | `Event listener failed, the message is retried` |
| `error` | `Event listener failed, the message is not retried`; `onFailure hook failed` |

Payloads are never logged.

## Errors

| Error | When |
| --- | --- |
| `TypeError` | Invalid options of `defineEvent()`, `defineListener()`, `createEventBus()`, `emit()`… |
| `EventPayloadError` | At `emit()`: the payload does not match the schema, or is not serializable as JSON. Fields: `event`, `issues`. |
| `EventEmitError` | Some messages could not be sent. Fields: `sent`, `failed`, `cause`. `retry()` sends the failed messages again, with the same ids: it resolves like `emit()`, or throws a new `EventEmitError` whose `sent` adds up the attempts. |
| `PartialSendError` | For transport authors: some messages of a `send()` call failed. |

The error classes extend `EventsError`.

## Custom transports

A transport has a `kind` and a `send(envelopes, { delay })` method; a source has a `kind` and a `consume(worker, { signal, logger })` method. Envelopes are plain JSON objects:

```ts
{ v: 1, id, emissionId, event, listener, payload, emittedAt, metadata }
```
