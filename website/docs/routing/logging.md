# Logging and error hooks

Dotpress logs through one logger, given to the app, and gives each request a logger of its own, bound to its request ID.

## The logger

By default, the app logs to the console, from the `info` level. Pass your logger to `createApp()`:

```ts
import pino from 'pino'

const app = await createApp({ adapter, logger: pino() })
```

The `Logger` interface is the one of [Pino](https://getpino.io): a Pino instance works as is. Any logger with `debug`, `info`, `warn`, `error` and `child()` methods, accepting `(message)` or `(data, message)`, works too.

The default logger can be configured:

```ts
import { createConsoleLogger } from '@dotpress/core'

const logger = createConsoleLogger({ level: 'debug', bindings: { service: 'billing-api' } })
```

## The request logger

`ctx.logger` is a child logger: every line it writes carries the `requestId` of the request.

```ts twoslash
import { defineRoute } from '@dotpress/core'

declare const payments: { refund(id: string): Promise<{ amount: number }> }
// ---cut---
defineRoute({
  method: 'post',
  path: '/payments/:id/refund',
  handler: async ({ req, logger }) => {
    const refund = await payments.refund(req.params.id)
    logger.info({ paymentId: req.params.id, amount: refund.amount }, 'Payment refunded')
    return refund
  },
})
```

Pass `ctx.logger` to the services a request calls: their log lines are tied to the request. `ctx.events` and `ctx.mailer` use the request logger for you.

## Request IDs

Each request gets an ID, `crypto.randomUUID()` by default. It is:

- `ctx.requestId` in handlers and middlewares;
- bound to every line of `ctx.logger`;
- sent back in the `X-Request-ID` header of every response, errors included.

To reuse the ID set by a gateway or a load balancer, use `generateRequestId`. Accept it only from a proxy you trust, and check its format:

```ts twoslash
import { createApp, type HttpAdapter } from '@dotpress/core'
declare const adapter: HttpAdapter
// ---cut---
const app = await createApp({
  adapter,
  generateRequestId: (request) => {
    const id = request.headers['x-request-id']
    return typeof id === 'string' && /^[\w-]{8,64}$/.test(id) ? id : crypto.randomUUID()
  },
})
```

## Logging every request

A small plugin logs every response with the `onResponse` hook, including the `404` and `405` of the router:

```ts twoslash
import { definePlugin } from '@dotpress/core'
// ---cut---
export const httpLogger = definePlugin({
  name: 'http-logger',
  setup(api) {
    api.hooks.onResponse(({ request, response, requestId, duration }) => {
      api.logger.info(
        { requestId, status: response.status, duration: Math.round(duration) },
        `${request.method} ${request.path}`
      )
    })
  },
})
```

```ts
const app = await createApp({ adapter, plugins: [httpLogger] })
```

The hook receives the request, the final response, the request ID, the duration in milliseconds, and the route when one matched (`route.path` is the declared path, such as `/users/:id`: a good label for metrics).

## Reporting errors

Unexpected errors are logged with the request logger, then passed to the `onError` hooks: the one of `createApp()`, and those of the plugins (`api.onError()`). See [Errors](./errors#unexpected-errors).

```ts
const app = await createApp({
  adapter,
  onError: (error, ctx) => errorTracker.capture(error, { requestId: ctx?.requestId }),
})
```

## Tracing and request-scoped storage

The `wrapRequest` hook of a plugin runs the whole pipeline of a request inside a function: a tracing span, or an `AsyncLocalStorage` context that services read without receiving `ctx`.

```ts twoslash
import { AsyncLocalStorage } from 'node:async_hooks'
import { definePlugin } from '@dotpress/core'
// ---cut---
export const requestStore = new AsyncLocalStorage<{ requestId: string }>()

export const requestStorePlugin = definePlugin({
  name: 'request-store',
  setup(api) {
    api.hooks.wrapRequest((ctx, next) => requestStore.run({ requestId: ctx.requestId }, next))
  },
})
```

The hook must call `next()` once, and return its result.

:::tip Coming from v1
Pino is no longer loaded automatically: pass it to `createApp({ logger })`. `enableHttpLogging` and `onRequestComplete` are replaced by the `onResponse` hook of a plugin, and `onException` by `onError`.
:::
