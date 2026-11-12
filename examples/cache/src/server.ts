import { expressAdapter } from '@dotpress/adapter-express'
import { createArticlesApp } from './app.ts'
import { createStore } from './store.ts'

const port = Number(process.env.PORT ?? 3000)

const { store, close } = await createStore()
if (store.name === 'memory') {
  console.warn(
    'REDIS_URL is not set: the cache lives in the memory of this process.'
  )
}

const app = await createArticlesApp({ adapter: expressAdapter(), store })
await app.listen(port)
console.log(`Articles API: http://localhost:${port}/articles`)

// Waits for pending requests, then closes the Redis connection.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(close)
  })
}
