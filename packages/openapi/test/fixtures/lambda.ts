// Entry point of AWS Lambda: the app is created at the first invocation.
// createLambdaHandler() registers its factory like this.
import { createApp, createRouter } from '@dotpress/core'
import { registerLazyApp } from '@dotpress/core/adapter'
import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'

const factory = async () => {
  const router = createRouter()
  router.defineRoute({ path: '/events', handler: () => [] })
  return createApp({
    adapter: memoryAdapter(),
    logger: createMemoryLogger(),
    routers: [router],
  })
}

registerLazyApp(factory)

export const handler = async () => (await factory()).routes.length
