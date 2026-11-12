// Entry point of the API: config → services → app → listen.
import { fastifyAdapter } from '@dotpress/adapter-fastify'
import { createConsoleLogger } from '@dotpress/core'
import { loadConfig, requireInProduction } from '../config.ts'
import { openDatabase } from '../db/database.ts'
import { loadKeys } from '../features/auth/keys.ts'
import { createNotifications } from '../features/notifications/listeners.ts'
import { createBus, createTransport } from '../services/bus.ts'
import { createCacheStore } from '../services/cache-store.ts'
import { createRepositories } from '../services/index.ts'
import { createAppMailer, createMailProvider } from '../services/mailer.ts'
import { createTasksApp } from './app.ts'

const config = loadConfig()
requireInProduction(config, [
  'PUBLIC_URL',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  // Without Redis, the API sends the emails itself.
  ...(config.REDIS_URL ? [] : (['SMTP_URL'] as const)),
])
const logger = createConsoleLogger()

// The services of this process, created once, closed on shutdown.
const repositories = createRepositories(openDatabase(config.DATABASE_PATH))
const cacheStore = await createCacheStore(config.REDIS_URL)
const mailProvider = createMailProvider(config)
const transport = createTransport(config)
if (transport.kind === 'memory') {
  logger.info('REDIS_URL is not set: the listeners run in this process')
} else if (mailProvider.name === 'console') {
  logger.info('SMTP_URL is not set: the worker prints the emails')
}

const app = await createTasksApp({
  adapter: fastifyAdapter(),
  repositories,
  keys: loadKeys(config),
  publicUrl: config.publicUrl,
  cacheStore: cacheStore.store,
  // The bus routes each event to its listeners, by name: with BullMQ, the
  // worker runs them; without, the in-memory queue of this process.
  events: createBus(
    transport,
    createNotifications({
      repositories,
      mailer: createAppMailer(mailProvider, config.MAIL_FROM),
    }),
    { logger }
  ),
  logger,
})
await app.listen(config.PORT)
logger.info(`Tasks API: ${config.publicUrl}`)
logger.info(`API reference: ${config.publicUrl}/docs`)

// Waits for pending requests, then closes the connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => transport.close())
      .then(() => cacheStore.close())
      .then(() => {
        mailProvider.close?.()
        repositories.db.close()
      })
  })
}
