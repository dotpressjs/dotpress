import { fastifyAdapter } from '@dotpress/adapter-fastify'
import { createTasksApp } from './app.ts'
import { loadKeys } from './auth/keys.ts'
import { createCacheStore } from './cache-store.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db/database.ts'

const config = loadConfig()
const db = openDatabase(config.DATABASE_PATH)
const cacheStore = await createCacheStore(config.REDIS_URL)

const app = await createTasksApp({
  adapter: fastifyAdapter(),
  db,
  keys: loadKeys(config),
  publicUrl: config.publicUrl,
  cacheStore: cacheStore.store,
})
await app.listen(config.PORT)
console.log(`Tasks API: ${config.publicUrl}`)
console.log(`API reference: ${config.publicUrl}/docs`)

// Waits for pending requests, then closes the connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => cacheStore.close())
      .then(() => db.close())
  })
}
