// Entry point of a server: creates the app, then listens. The memory
// adapter starts no server, so app.listen() throws outside document mode.
import { createApp, createRouter } from '@dotpress/core'
import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'

const router = createRouter()
router.defineRoute({ path: '/orders', handler: () => [] })

const app = await createApp({
  adapter: memoryAdapter(),
  logger: createMemoryLogger(),
  routers: [router],
})
const { port } = await app.listen(3000)
console.log(`Listening on port ${port}`)
