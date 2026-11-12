import { createMemoryStore, type CacheStore } from '@dotpress/cache'
import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'
import { createArticlesApp } from '../src/app.ts'
import { createDatabase } from '../src/db.ts'
import { createStore, type ClosableStore } from '../src/store.ts'

type StoreFactory = () => Promise<ClosableStore>

/**
 * The stores the cache tests run on: memory, and Redis when REDIS_URL is
 * set (docker compose up -d; the CI has it).
 */
export const stores: [name: string, create: StoreFactory][] = [
  [
    'memory',
    async () => ({ store: createMemoryStore(), close: async () => {} }),
  ],
]
const redisUrl = process.env.REDIS_URL
if (redisUrl) stores.push(['redis', () => createStore({ REDIS_URL: redisUrl })])

let runs = 0

/** The app on the memory adapter, with a fake database counting queries. */
export const startApp = async (store: CacheStore = createMemoryStore()) => {
  const adapter = memoryAdapter()
  const db = createDatabase()
  const app = await createArticlesApp({
    adapter,
    store,
    db,
    // Keys of their own in a shared store: tests do not see each other.
    prefix: `articles-test-${process.pid}-${Date.now()}-${runs++}`,
    logger: createMemoryLogger(),
  })

  const request = (path: string, init?: RequestInit) =>
    adapter.fetch(new Request(`http://localhost${path}`, init))

  const patch = (path: string, body: unknown, userId?: string) =>
    request(path, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(userId && { 'x-user-id': userId }),
      },
      body: JSON.stringify(body),
    })

  /** The queries made by `run`. */
  const queriesOf = async (run: () => Promise<unknown>) => {
    const before = db.queries.length
    await run()
    return db.queries.slice(before)
  }

  return { db, request, patch, queriesOf, close: () => app.close() }
}
