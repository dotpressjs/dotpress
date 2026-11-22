# @dotpress/core

The core of [Dotpress](https://dotpress.dev), a lightweight, decorator-free TypeScript framework for end-to-end typed HTTP APIs: routes, validation with Zod, returned errors, middlewares and plugins. It knows no HTTP server: an adapter runs it on Express, Fastify, Hono or AWS Lambda.

> 🚧 Dotpress V2 is in beta (`2.0.0-beta`): the API is complete, and changes before 2.0.0 only from feedback.

```sh
npm install @dotpress/core @dotpress/adapter-express express zod
```

```ts
import { createApp, defineRoute, notFoundError } from '@dotpress/core'
import { expressAdapter } from '@dotpress/adapter-express'

defineRoute({
  method: 'post',
  path: '/projects/:projectId/tasks',
  status: 201,
  schema: (z) => ({
    body: z.object({ title: z.string().min(1), dueOn: z.iso.date().optional() }),
  }),
  handler: async ({ req }) => {
    // req.params: { projectId: string }, req.body: { title: string; dueOn?: string }
    const project = await findProject(req.params.projectId)
    if (!project) return notFoundError('Project not found')
    return createTask(project.id, req.body)
  },
})

const app = await createApp({ adapter: expressAdapter() })
await app.listen(3000)
```

## Documentation

- [Getting started](https://dotpress.dev/getting-started/introduction)
- [Concepts](https://dotpress.dev/concepts/how-it-works): the request pipeline, the context, typing, errors
- [HTTP routing](https://dotpress.dev/routing/routes): routes, groups, validation, responses, errors, middlewares, bodies and uploads, CORS, logging, plugins, testing
- [API reference](https://dotpress.dev/reference/application)
- [Migrate from v1](https://dotpress.dev/reference/migrate-from-v1)

## License

MIT
