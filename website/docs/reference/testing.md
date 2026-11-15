# Testing

The helpers of `@dotpress/testing`, built on [Vitest](https://vitest.dev). For guides, see [Testing](/routing/testing) and [Testing helpers](/services/testing).

```sh
npm install -D @dotpress/testing vitest
```

## createTestApp()

```ts
import { createTestApp } from '@dotpress/testing'

const { fetch, logger, close } = await createTestApp({ routers: [tasksRouter], plugins: [authPlugin(auth)] })
const res = await fetch('/tasks', { headers: { authorization: `Bearer ${token}` } })
```

Creates an app on the memory adapter. It takes the options of `createApp()`, except `adapter`, which takes the options of the memory adapter, and `logger`, a memory logger (a new one by default).

| Member | Description |
| --- | --- |
| `fetch(path, init?)` | Sends a request, like `fetch()`: `path` is relative to `http://localhost`. |
| `app` | The app. |
| `adapter` | The memory adapter. |
| `logger` | The memory logger of the app. |
| `close()` | Closes the app. |

## memoryAdapter()

The adapter of `createTestApp()`, for an app created by your own code: `createTasksApp({ adapter: memoryAdapter() })`. Its `fetch(request)` takes a Web `Request`.

| Option | Default | Description |
| --- | --- | --- |
| `bodyLimit` | 1 MiB | Maximum body size, in bytes. |
| `ip` | `'127.0.0.1'` | The client IP address of the requests. |

## createMemoryLogger()

A logger that records its lines in `entries` (`{ level, args }`) instead of printing them.

## Assertions

| Function | Description |
| --- | --- |
| `expectEventEmitted(source, event, payload?, { times?, metadata?, delay? })` | An event was emitted, with a payload matching partially. Returns the last matching emission. |
| `expectEventNotEmitted(source, event, payload?)` | No such event was emitted. |
| `expectMailSent(outbox, criteria?, { times? })` | A message was sent, matching the criteria. Returns the last matching one. |
| `expectNoMailSent(outbox, criteria?)` | No such message was sent. |

The source of events is a fake event bus (`createFakeEventBus()`) or a memory transport; the outbox is the memory provider of the mailer. A failed assertion throws an `ExpectationError` that lists what was emitted or sent.

| Mail criterion | Matches |
| --- | --- |
| `to`, `cc`, `bcc`, `replyTo` | An address, or a list (`ExpectedAddresses`), all among the recipients. |
| `from` | The sender. |
| `template` | The template, or its name. |
| `subject`, `html`, `text`, `locale`, `tags`, `metadata`, `headers`, `attachments` | Like `toMatchObject()`, with asymmetric matchers. |

## AWS Lambda

| Function | Description |
| --- | --- |
| `createLambdaTarget(handler, { format, close?, sourceIp? })` | A `TestTarget` that sends each request to a Lambda handler as an event of the format (`'v1'`, `'v2'` or `'alb'`). A failed invocation gets a `502`. |
| `toLambdaEvent(request, format, sourceIp?)` | The event of a Web `Request`. |
| `fromLambdaResult(result)` | The Web `Response` of a result. |

## @dotpress/testing/conformance

The conformance suite of the adapters: see [Writing an adapter](/services/testing#writing-an-adapter).

| Export | Description |
| --- | --- |
| `runConformanceSuite({ name, setup, bufferedResponses? })` | Registers the tests of the suite. `setup(options)` creates an app with the adapter under test and the given options, and returns a `TestTarget`. `bufferedResponses` skips the scenarios that need incremental streaming. |
| `createHttpTarget(baseUrl, { close? })` | A target for a server listening on a port. |
| `createFetchTarget(handle, { close? })` | A target for a function taking a Web `Request` and returning a `Response`. |

A `TestTarget` has `fetch(path, init?)` and `close()`, which does nothing by default.
