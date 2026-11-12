import { createMemoryStore, type CacheStore } from '@dotpress/cache'
import { createRedisStore } from '@dotpress/cache/redis'
import { createClient } from 'redis'

/** A store, and how to close it on shutdown. */
export interface ClosableStore {
  store: CacheStore
  close(): Promise<void>
}

/**
 * With `REDIS_URL`, the cache is shared by every instance of the API, and
 * survives restarts. Without it, it lives in the memory of the process:
 * fine for a single instance.
 */
export const createStore = async (
  env: Record<string, string | undefined> = process.env,
  logger: Pick<Console, 'error'> = console
): Promise<ClosableStore> => {
  if (!env.REDIS_URL) {
    return { store: createMemoryStore(), close: async () => {} }
  }

  // The client of the app: it connects and closes it.
  const client = createClient({ url: env.REDIS_URL })
  client.on('error', (error) => logger.error('Redis error', error))
  await client.connect()
  return {
    store: createRedisStore({ client }),
    close: async () => void (await client.close()),
  }
}
