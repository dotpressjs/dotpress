import { fastifyAdapter } from '@dotpress/adapter-fastify'
import { createConsoleLogger } from '@dotpress/core'
import { createOrdersApp } from './app.ts'
import { createBus, createTransport } from './bus.ts'

const port = Number(process.env.PORT ?? 3000)
const logger = createConsoleLogger()

const transport = createTransport()
if (transport.kind === 'memory') {
  logger.info(
    'REDIS_URL is not set: the listeners run in this process, from an in-memory queue'
  )
}

const app = await createOrdersApp({
  adapter: fastifyAdapter(),
  events: createBus(transport, { logger }),
  logger,
})
await app.listen(port)
logger.info(`Orders API: http://localhost:${port}/orders`)

// Waits for pending requests, then closes the connection to the queue.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => transport.close())
  })
}
