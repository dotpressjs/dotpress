# @dotpress/adapter-express

[Express](https://expressjs.com) adapter for [Dotpress](https://dotpress.dev). Supports Express 4 and 5.

> 🚧 Dotpress V2 is in beta (`2.0.0-beta`): the API is complete, and changes before 2.0.0 only from feedback.

```sh
npm install @dotpress/core @dotpress/adapter-express express zod
npm install --save-dev @types/express
```

```ts
import { createApp, defineRoute } from '@dotpress/core'
import { expressAdapter } from '@dotpress/adapter-express'
import helmet from 'helmet'

defineRoute({ path: '/hello', handler: () => ({ message: 'Hello' }) })

const app = await createApp({
  adapter: expressAdapter({
    // Native Express middlewares, before the Dotpress routes
    beforeRoutes: (app) => {
      app.use(helmet())
    },
  }),
})

await app.listen(3000)
```

## Documentation

- [The Express adapter](https://dotpress.dev/adapters/express): options, behavior, native middlewares, your own server
- [Choosing an adapter](https://dotpress.dev/adapters/)
- [Node.js and containers](https://dotpress.dev/deployment/node)

## License

MIT
