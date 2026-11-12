import { createMemoryStore, type CacheStore } from '@dotpress/cache'
import { createRedisStore } from '@dotpress/cache/redis'
import { createClient } from 'redis'

/** A cache store, and how to close it on shutdown. */
export interface ClosableStore {
  store: CacheStore
  close(): Promise<void>
}

/**
 * Redis with `REDIS_URL`: one cache for every instance of the API. The
 * memory of the process otherwise: fine for a single instance.
 */
export const createCacheStore = async (
  redisUrl: string | undefined,
  logger: Pick<Console, 'error'> = console
): Promise<ClosableStore> => {
  if (!redisUrl) return { store: createMemoryStore(), close: async () => {} }

  const client = createClient({ url: redisUrl })
  client.on('error', (error) => logger.error('Redis error', error))
  await client.connect()
  return {
    store: createRedisStore({ client }),
    close: async () => void (await client.close()),
  }
}
