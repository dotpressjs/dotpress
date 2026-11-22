# @dotpress/testing

Testing helpers for [Dotpress](https://dotpress.dev): a test app in memory, the adapter conformance suite, simulated AWS Lambda events, a memory logger, and assertions for events and emails.

> 🚧 Dotpress V2 is in beta (`2.0.0-beta`): the API is complete, and changes before 2.0.0 only from feedback.

```sh
npm install --save-dev @dotpress/testing vitest
```

```ts
import { createTestApp } from '@dotpress/testing'
import { expect, it } from 'vitest'

it('creates a task', async () => {
  const api = await createTestApp({ routers: [tasksRouter] })

  const res = await api.fetch('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Write the tests' }),
  })

  expect(res.status).toBe(201)
  await api.close()
})
```

## Documentation

- [Testing routes](https://dotpress.dev/routing/testing): the test app, authenticated requests, a real server
- [Testing helpers](https://dotpress.dev/services/testing): events, emails, logs, AWS Lambda, the conformance suite for adapters

## License

MIT
