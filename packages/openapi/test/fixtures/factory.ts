// App without openapiPlugin(), created by a factory. Erasable TypeScript
// only: Node.js runs it with type stripping.
import { createRouter, type Router } from '@dotpress/core'
import { createTestApp } from '@dotpress/testing'

const define = (router: Router): void => {
  router.defineRoute({
    path: '/items',
    schema: (z) => ({ response: z.array(z.object({ id: z.string() })) }),
    handler: () => [],
  })
  router.defineRoute({
    path: '/big',
    schema: (z) => ({ response: z.bigint() }),
    handler: () => 1n,
  })
}

export const createApp = async () => {
  const router = createRouter()
  define(router)
  const { app } = await createTestApp({ routers: [router] })
  return app
}

export const notAnApp = { routes: 'none' }

export const failing = async (): Promise<never> => {
  throw new Error('Database unavailable')
}

/** Leaves a timer running, like a connection pool that is never closed. */
export const leaky = async () => {
  setInterval(() => {}, 1000)
  return createApp()
}
