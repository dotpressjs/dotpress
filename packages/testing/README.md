# @dotpress/testing

Testing helpers for [Dotpress](https://dotpress.dev).

> 🚧 Dotpress V2 is under active development and not published yet.

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

## License

MIT
