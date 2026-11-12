import { fastifyAdapter } from '@dotpress/adapter-fastify'
import { createConsoleLogger } from '@dotpress/core'
import { createTasksApp } from './app.ts'
import { loadKeys } from './auth/keys.ts'
import { createBus, createTransport } from './bus.ts'
import { createCacheStore } from './cache-store.ts'
import { loadConfig, requireInProduction } from './config.ts'
import { openDatabase } from './db/database.ts'
import { createNotifications } from './notifications/listeners.ts'
import { createAppMailer, createMailProvider } from './notifications/mailer.ts'

const config = loadConfig()
requireInProduction(config, [
  'PUBLIC_URL',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  // Without Redis, the API sends the emails itself.
  ...(config.REDIS_URL ? [] : (['SMTP_URL'] as const)),
])
const logger = createConsoleLogger()

const db = openDatabase(config.DATABASE_PATH)
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
  db,
  keys: loadKeys(config),
  publicUrl: config.publicUrl,
  cacheStore: cacheStore.store,
  // The bus routes each event to its listeners, by name: with BullMQ, the
  // worker runs them; without, the in-memory queue of this process.
  events: createBus(
    transport,
    createNotifications({
      db,
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
        db.close()
      })
  })
}
