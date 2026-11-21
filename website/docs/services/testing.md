# Testing helpers

`@dotpress/testing` runs your app in memory, and checks what it does besides answering: the events it emits, the emails it sends, its Lambda handler. For the basics (the memory adapter, `createTestApp()`), see [Testing](/routing/testing).

```sh
npm install -D @dotpress/testing vitest
```

## Events

`expectEventEmitted()` checks that an event was emitted, and returns the last matching emission. The source is a fake event bus, which checks the emissions like a real bus without running the listeners, or a memory transport, which runs them:

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
- `payload`: objects are matched partially (like `toMatchObject()`), other values exactly; asymmetric matchers work (`expect.any(String)`).
- `options`: `times` (an exact number; at least one by default), `metadata` (matched partially), `delay`.

With the plugin, give the fake bus to `eventsPlugin()`: `ctx.events` records into it, with the `requestId` in the metadata.

## Emails

`expectMailSent()` checks the messages kept by the memory provider of the mailer (`outbox.sent`, `last()`, `clear()`), and returns the last matching one. `renderMail(template, { locale, defaultLocale, data })` renders a template without a mailer, to test each locale:

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

- `to`, `cc`, `bcc`, `replyTo`: an address or a list, all among the recipients. `from`: the sender.
- `template`: the template, or its name.
- `subject`, `html`, `text`, `locale`, `tags`, `metadata`, `headers`, `attachments`: matched like `toMatchObject()`, with asymmetric matchers.
- `options.times`: an exact number of messages.

A failed assertion throws an `ExpectationError` listing what was emitted or sent: the failure explains itself.

## Logs

`createMemoryLogger()` records the log lines instead of printing them: the tests stay quiet, and can check what was logged.

```ts
const logger = createMemoryLogger()
await createApp({ adapter, logger })

expect(logger.entries).toContainEqual({
  level: 'error',
  args: [expect.any(Error), 'Unhandled error while processing request'],
})
```

## AWS Lambda

`createLambdaTarget(handler, { format, close? })` sends requests to a Lambda handler as simulated events, and converts the results back: test the handler without an AWS account. `format` is `'v1'` (API Gateway REST API), `'v2'` (HTTP API, Function URLs), `'alb'` (Application Load Balancer with multi-value headers) or `'alb-single-value'` (without them, the default of a target group: one value per header and query key, and the response headers read from `headers` only). A failed invocation gets a `502`, like API Gateway. To run the conformance suite on a Lambda handler, pass `bufferedResponses: true`: the scenarios that need incremental streaming or client disconnections are skipped.

`toLambdaEvent()` and `fromLambdaResult()` are exported for finer tests. The [Fastify](/examples/fastify) and [Hono](/examples/hono) examples test their handler, and their bundle, this way.

## Writing an adapter

Every adapter of Dotpress passes the conformance suite, `runConformanceSuite()`: routing, parsing, validation, errors, middlewares and responses, streams and Server-Sent Events included. An adapter for another server runs it too:

```ts
import { createApp } from '@dotpress/core'
import { createHttpTarget, runConformanceSuite } from '@dotpress/testing/conformance'
import { myAdapter } from '../src/index.ts'

runConformanceSuite({
  name: 'my-adapter',
  async setup(options) {
    const adapter = myAdapter()
    const app = await createApp({ ...options, adapter })
    const { port } = await app.listen(0, '127.0.0.1')
    return createHttpTarget(`http://127.0.0.1:${port}`, { close: () => app.close() })
  },
})
```

The suite has its own entry, `@dotpress/testing/conformance`. A target sends the requests of the suite (`fetch(path, init)`) and stops the app (`close()`, the option of the same name, which does nothing by default). An adapter that does not listen on a port returns `createFetchTarget(handle, { close })`, where `handle` takes a Web `Request` and returns a `Response`.

Every helper and option: see the [Testing reference](/reference/testing).
