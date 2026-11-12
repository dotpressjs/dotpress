---
pageType: home

hero:
  name: Dotpress
  text: End-to-end typed backend APIs
  tagline: A lightweight, decorator-free TypeScript framework. Your schemas type each request, its response and its errors, on the HTTP server you choose.
  badge: 2.0 alpha
  actions:
    - theme: brand
      text: Get started
      link: /getting-started/installation
    - theme: alt
      text: Examples
      link: /examples/

features:
  - title: Typed from end to end
    details: Zod schemas validate and type the params, the query, the body and the response of each route. The OpenAPI document comes from the same routes.
    icon: 🔷
    span: 6
  - title: Errors are returned
    details: Handlers return their errors instead of throwing them, so the errors of a route are part of its type.
    icon: ↩️
    span: 6
  - title: Any HTTP server
    details: The core knows no HTTP server. The same app runs on Express, Fastify or Hono, and on AWS Lambda.
    icon: 🔌
    span: 6
  - title: Packages when you need them
    details: Authentication, OpenAPI, emails, events, cache and testing helpers, each in its own package.
    icon: 📦
    span: 6
---

## A route, as the editor sees it

Hover the code: the types come from the schemas. This snippet is compiled against Dotpress when the site is built.

```ts twoslash
import { defineRoute, notFoundError } from '@dotpress/core'

declare const findProject: (id: string) => Promise<{ name: string } | null>

defineRoute({
  method: 'post',
  path: '/projects/:projectId/tasks',
  schema: (z) => ({
    body: z.object({
      title: z.string().min(1),
      dueOn: z.iso.date().optional(),
    }),
  }),
  handler: async ({ req }) => {
    const project = await findProject(req.params.projectId)
    if (!project) return notFoundError('Project not found')
    const task = { ...req.body, project: project.name }
    return task
  },
})
```
