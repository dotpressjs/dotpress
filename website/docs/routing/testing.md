# Testing

A Dotpress app is tested in memory: the memory adapter of `@dotpress/testing` runs the requests through the real pipeline, with the routes, middlewares, validation and plugins of the app, without opening a port. The tests are fast, and need no mock of the framework.

```sh
npm install -D @dotpress/testing vitest
```

`@dotpress/testing` needs [Vitest](https://vitest.dev): its assertions (`expectMailSent()`, `expectEventEmitted()`…) and the conformance suite of the adapters are built on it.

## Test routes

`createTestApp()` creates an app on the memory adapter, with the routers and plugins you give it, and returns a `fetch()` relative to `http://localhost`:

```ts title="test/articles.test.ts"
import { createTestApp } from '@dotpress/testing'
import { afterEach, expect, it } from 'vitest'
import { articlesRouter } from '../src/articles.ts'

let close: () => Promise<void>
afterEach(() => close())

it('rejects an article without title', async () => {
  const app = await createTestApp({ routers: [articlesRouter] })
  close = app.close

  const res = await app.fetch('/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '' }),
  })

  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ error: 'VALIDATION_FAILED' })
})
```

`app.logger` records the log lines instead of printing them: tests stay quiet, and can check what was logged.

## Test the app as in production

When the app is created by a function of yours (see [Project structure](/getting-started/project-structure)), give it the memory adapter and in-memory services. The test runs the app exactly as configured in production:

```ts title="test/tasks.test.ts"
import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'
import { beforeEach, expect, it } from 'vitest'
import { createTasksApp } from '../src/app.ts'
import { createMemoryStore } from './support.ts'

let adapter: ReturnType<typeof memoryAdapter>

beforeEach(async () => {
  adapter = memoryAdapter()
  await createTasksApp({ adapter, store: createMemoryStore(), logger: createMemoryLogger() })
})

it('creates a task and reads it back', async () => {
  const created = await adapter.fetch(
    new Request('http://localhost/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Write the tests' }),
    })
  )
  expect(created.status).toBe(201)

  const task = await created.json()
  const res = await adapter.fetch(new Request(`http://localhost/tasks/${task.id}`))
  expect(await res.json()).toEqual(task)
})
```

Each test creates its own app and services: no state leaks from one test to the next.

## Authenticated requests

With `@dotpress/auth`, log in through the real route, or generate a token with the auth service, and send it like a client:

```ts
const { accessToken } = await auth.generateTokensForUser({ userId: user.id })
const res = await app.fetch('/profile', {
  headers: { authorization: `Bearer ${accessToken}` },
})
```

## On a real server

A few tests can run the app on its real server, to check the integration with it (native middlewares, proxy settings). Listen on port `0` to get a free port:

```ts
import type { AddressInfo } from 'node:net'
import { expressAdapter } from '@dotpress/adapter-express'

const adapter = expressAdapter()
const app = await createTasksApp({ adapter })
await app.listen(0, '127.0.0.1')

const { port } = adapter.server()!.address() as AddressInfo
const res = await fetch(`http://127.0.0.1:${port}/tasks`)

await app.close()
```

The memory adapter passes the same conformance suite as the other adapters: the behavior tested in memory is the behavior on the server.

## Events, emails and Lambda

`@dotpress/testing` also checks the events emitted and the emails sent, and runs a Lambda handler with simulated events. See [Testing helpers](/services/testing).
