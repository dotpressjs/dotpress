# @dotpress/testing

Testing helpers for [Dotpress](https://dotpress.dev): a test app, the adapter conformance suite, and assertions for events and mail.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

## Adapter conformance suite

Every Dotpress HTTP adapter must pass the conformance suite, which checks that routing, request parsing, validation, errors, middlewares and responses (including streams and Server-Sent Events) behave the same on every server.

```ts
// conformance.test.ts (run with vitest)
import type { AddressInfo } from 'node:net'
import { createApp } from '@dotpress/core'
import { createHttpTarget, runConformanceSuite } from '@dotpress/testing'
import { myAdapter } from '../src/index.js'

runConformanceSuite({
  name: 'my-adapter',
  async setup(options) {
    const adapter = myAdapter()
    const app = await createApp({ ...options, adapter })
    await app.listen(0, '127.0.0.1')

    const { port } = adapter.server().address() as AddressInfo
    return createHttpTarget(`http://127.0.0.1:${port}`, () => app.close())
  },
})
```

`setup()` is called once per test with the app options of the scenario. Adapters that do not listen on a port return `createFetchTarget(handle, close)`, where `handle` takes a Web `Request` and returns a `Response` (in-memory `fetch()`).

### AWS Lambda

`createLambdaTarget(handler, { format, close })` sends each request to a Lambda handler as a simulated event, and converts the result back: `format` is `'v1'` (API Gateway REST API), `'v2'` (HTTP API, Function URLs) or `'alb'` (Application Load Balancer, with multi-value headers). A failed invocation gets a `502` response, like API Gateway. `toLambdaEvent()` and `fromLambdaResult()` are exported for handler tests.

```ts
runConformanceSuite({
  name: 'my-adapter (AWS Lambda)',
  // Responses sent once complete: skips the scenarios that need incremental
  // streaming or client disconnects.
  bufferedResponses: true,
  setup: async (options) => {
    let app
    const handler = createLambdaHandler(async () => (app = await createApp({ ...options, adapter: myAdapter() })))
    return createLambdaTarget(handler, { format: 'v2', close: async () => app?.close() })
  },
})
```

## Memory logger

`createMemoryLogger()` records log entries instead of printing them:

```ts
const logger = createMemoryLogger()
await createApp({ adapter, logger })
expect(logger.entries).toContainEqual({ level: 'error', args: [error, 'Unhandled error while processing request'] })
```

## Event assertions

`expectEventEmitted(source, event, payload?, options?)` asserts that an event was emitted, and returns the last matching emission. The source is a fake event bus (`createFakeEventBus()` of `@dotpress/events`: it checks emissions like a real bus, without running listeners), or a memory transport (`createMemoryTransport()`: it only sees the events that have listeners on it).

```ts
import { createFakeEventBus } from '@dotpress/events'
import { expectEventEmitted, expectEventNotEmitted } from '@dotpress/testing'

const events = createFakeEventBus()
await signUp(events, 'ada@example.com')

expectEventEmitted(events, userCreated, { email: 'ada@example.com' })
expectEventEmitted(events, 'user.created', undefined, { times: 1, metadata: { requestId: 'req-1' } })
expectEventNotEmitted(events, userDeleted)
```

- `event`: the definition, or its name.
- `payload`: objects are matched partially (like `toMatchObject()`), other values exactly; asymmetric matchers are accepted (`expect.any(String)`). Without it, any payload matches.
- `options`: `times` (exact number of emissions; at least one by default), `metadata` (matched partially), `delay` (fake event bus only).

With the Dotpress plugin, pass the fake bus to `eventsPlugin()`: `ctx.events` records into it, with the `requestId` in the metadata.

## Mail assertions

`expectMailSent(outbox, criteria?, options?)` asserts that a message was sent through the memory provider of the mailer (`createMemoryProvider()` of `@dotpress/mailer`), and returns the last matching message.

```ts
import { createMailer, createMemoryProvider } from '@dotpress/mailer'
import { expectMailSent, expectNoMailSent } from '@dotpress/testing'

const outbox = createMemoryProvider()
const mailer = createMailer({ provider: outbox, from: 'noreply@example.com' })
await signUp(mailer, 'ada@example.com')

const mail = expectMailSent(outbox, { to: 'ada@example.com', template: welcomeMail, locale: 'en' })
expect(mail.html).toContain('https://example.com/confirm')
expectNoMailSent(outbox, { to: 'grace@example.com' })
```

- `to`, `cc`, `bcc`, `replyTo`: an address or an array of addresses, all among the recipients (any case). `from`: the address of the sender.
- `template`: the template, or its name.
- `subject`, `html`, `text`, `locale`, `tags`, `metadata`, `headers`, `attachments`: matched like `toMatchObject()`, with asymmetric matchers (`expect.stringContaining('invoice')`).
- `options.times`: exact number of messages; at least one by default.

Failed assertions throw an `ExpectationError` that lists what was emitted or sent.

## License

MIT
