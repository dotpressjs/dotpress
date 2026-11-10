import type { CacheStore } from '../store.js'

/** A connected node-redis client (`createClient()` of `redis`, v4 or later). */
export interface NodeRedisClient {
  sendCommand(args: string[]): Promise<unknown>
}

/** An ioredis client (`new Redis()` of `ioredis`). */
export interface IoRedisClient {
  call(command: string, ...args: string[]): Promise<unknown>
}

/** Options of `createRedisStore()`. */
export interface RedisStoreOptions {
  /**
   * A node-redis client (connected) or an ioredis client, created and
   * closed by the app. Redis and Valkey servers, without cluster mode.
   */
  client: NodeRedisClient | IoRedisClient
  /** Name of the store, in logs and errors. Defaults to `redis`. */
  name?: string | undefined
}

// Releases a lock only if it is still held with this token.
const UNLOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`

/** A value of a GET or MGET reply: a string, or undefined for nil (null). */
const valueOf = (reply: unknown) => {
  if (reply === null) return undefined
  if (typeof reply === 'string') return reply
  throw new TypeError(
    `Unexpected reply from Redis (${typeof reply}): use a client that returns strings.`
  )
}

/**
 * Creates a store on Redis or Valkey, with the client of the app
 * (node-redis or ioredis). It supports `getMany` (MGET) and the `lock`
 * option of the cache (`SET NX PX`, released by a Lua script).
 *
 * ```ts
 * import { createClient } from 'redis'
 * import { createRedisStore } from '@dotpress/cache/redis'
 *
 * const client = createClient({ url: process.env.REDIS_URL })
 * client.on('error', (error) => logger.error({ error }, 'Redis error'))
 * await client.connect()
 * const cache = createCache({ store: createRedisStore({ client }), prefix: 'app' })
 * ```
 */
export const createRedisStore = (options: RedisStoreOptions): CacheStore => {
  const label = 'createRedisStore()'
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (key !== 'client' && key !== 'name') {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  const { client, name = 'redis' } = options
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(`${label}: name must be a non-empty string.`)
  }
  const value = client as unknown as Record<string, unknown> | null
  if (value?.isCluster === true || typeof value?.getMasters === 'function') {
    throw new TypeError(
      `${label}: Redis Cluster clients are not supported: use a client of a standalone server (or of the primary).`
    )
  }

  let run: (args: string[]) => Promise<unknown>
  if (typeof value?.call === 'function') {
    const io = client as IoRedisClient
    run = ([command, ...args]) => io.call(command as string, ...args)
  } else if (typeof value?.sendCommand === 'function') {
    const node = client as NodeRedisClient
    run = (args) => node.sendCommand(args)
  } else {
    throw new TypeError(
      `${label}: client must be a node-redis or an ioredis client.`
    )
  }

  /** TTL in whole milliseconds (the cache gives at least 1). */
  const px = (ttl: number) => String(Math.ceil(ttl))

  return Object.freeze({
    name,
    get: async (key: string) => valueOf(await run(['GET', key])),
    getMany: async (keys: readonly string[]) => {
      if (keys.length === 0) return []
      const reply = await run(['MGET', ...keys])
      if (!Array.isArray(reply) || reply.length !== keys.length) {
        throw new TypeError('Unexpected reply from Redis to MGET.')
      }
      return reply.map(valueOf)
    },
    set: async (key: string, value: string, ttl: number) => {
      await run(['SET', key, value, 'PX', px(ttl)])
    },
    delete: async (key: string) => {
      await run(['DEL', key])
    },
    lock: async (key: string, ttl: number) => {
      const token = crypto.randomUUID()
      const reply = await run(['SET', key, token, 'NX', 'PX', px(ttl)])
      return reply === 'OK' ? token : undefined
    },
    unlock: async (key: string, token: string) => {
      await run(['EVAL', UNLOCK, '1', key, token])
    },
  })
}
