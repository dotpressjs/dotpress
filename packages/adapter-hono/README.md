# @dotpress/adapter-hono

[Hono](https://hono.dev) adapter for [Dotpress](https://dotpress.dev), on Node.js and AWS Lambda. Supports Hono 4.13 or later; Hono 5 is tested against its release candidate.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

```sh
npm install @dotpress/core @dotpress/adapter-hono hono @hono/node-server zod
```

```ts
import { createApp, defineRoute } from '@dotpress/core'
import { honoAdapter } from '@dotpress/adapter-hono/node'
import { secureHeaders } from 'hono/secure-headers'

defineRoute({ path: '/hello', handler: () => ({ message: 'Hello' }) })

const app = await createApp({
  adapter: honoAdapter({
    // Native Hono middlewares, before the Dotpress routes
    beforeRoutes: (app) => {
      app.use('*', secureHeaders())
    },
  }),
})

await app.listen(3000)
```

On AWS Lambda, with `@hono/aws-lambda` and the main entry, which has no Node.js server:

```ts
import { honoAdapter } from '@dotpress/adapter-hono'
import { createLambdaHandler } from '@dotpress/adapter-hono/lambda'

export const handler = createLambdaHandler(() => createApp({ adapter: honoAdapter() }))
```

## Documentation

- [The Hono adapter](https://dotpress.dev/adapters/hono): options, native middlewares, bodies, errors, other runtimes
- [The AWS Lambda adapter](https://dotpress.dev/adapters/aws-lambda)
- [Choosing an adapter](https://dotpress.dev/adapters/)

## License

MIT
