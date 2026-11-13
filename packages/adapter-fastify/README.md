# @dotpress/adapter-fastify

[Fastify](https://fastify.dev) adapter for [Dotpress](https://dotpress.dev), on Node.js and AWS Lambda. Supports Fastify 5.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

```sh
npm install @dotpress/core @dotpress/adapter-fastify fastify zod
```

```ts
import { createApp, defineRoute } from '@dotpress/core'
import { fastifyAdapter } from '@dotpress/adapter-fastify'
import helmet from '@fastify/helmet'

defineRoute({ path: '/hello', handler: () => ({ message: 'Hello' }) })

const app = await createApp({
  adapter: fastifyAdapter({
    // Fastify plugins and hooks applied to the Dotpress routes
    beforeRoutes: async (app) => {
      await app.register(helmet)
    },
  }),
})

await app.listen(3000)
```

On AWS Lambda, with `@fastify/aws-lambda`:

```ts
import { createLambdaHandler } from '@dotpress/adapter-fastify/lambda'

export const handler = createLambdaHandler(() => createApp({ adapter: fastifyAdapter() }))
```

## Documentation

- [The Fastify adapter](https://dotpress.dev/adapters/fastify): options, native routes and hooks, bodies, errors, streams
- [The AWS Lambda adapter](https://dotpress.dev/adapters/aws-lambda)
- [Choosing an adapter](https://dotpress.dev/adapters/)

## License

MIT
