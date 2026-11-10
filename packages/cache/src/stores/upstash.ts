import type { CacheStore } from '../store.js'

/** Options of `createUpstashStore()`. */
export interface UpstashStoreOptions {
  /** REST URL of the database (`UPSTASH_REDIS_REST_URL`). */
  url: string
  /** REST token of the database (`UPSTASH_REDIS_REST_TOKEN`), not read-only. */
  token: string
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined
  /** Name of the store, in logs and errors. Defaults to `upstash`. */
  name?: string | undefined
}

// Releases a lock only if it is still held with this token.
const UNLOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`

/** A value of a GET or MGET result: a string, or undefined for null. */
const valueOf = (result: unknown) => {
  if (result === null) return undefined
  if (typeof result === 'string') return result
  throw new TypeError(`Unexpected result from Upstash (${typeof result}).`)
}

/**
 * Creates a store on [Upstash Redis](https://upstash.com/docs/redis), over
 * its REST API with `fetch`: no dependency, and it runs on every runtime
 * (Cloudflare Workers, Vercel, Deno, Node.js…). It supports `getMany` and
 * the `lock` option of the cache.
 *
 * ```ts
 * const store = createUpstashStore({
 *   url: env.UPSTASH_REDIS_REST_URL,
 *   token: env.UPSTASH_REDIS_REST_TOKEN,
 * })
 * ```
 */
export const createUpstashStore = (
  options: UpstashStoreOptions
): CacheStore => {
  const label = 'createUpstashStore()'
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (!['url', 'token', 'fetch', 'name'].includes(key)) {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  const {
    url,
    token,
    fetch: fetchFn = globalThis.fetch,
    name = 'upstash',
  } = options
  if (typeof url !== 'string' || !/^https?:\/\/[^/]/.test(url)) {
    throw new TypeError(
      `${label}: url must be the REST URL of the database (UPSTASH_REDIS_REST_URL).`
    )
  }
  if (typeof token !== 'string' || token === '') {
    throw new TypeError(
      `${label}: token must be the REST token of the database (UPSTASH_REDIS_REST_TOKEN).`
    )
  }
  if (typeof fetchFn !== 'function') {
    throw new TypeError(`${label}: fetch must be a function.`)
  }
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(`${label}: name must be a non-empty string.`)
  }
  const endpoint = url.replace(/\/+$/, '')

  /** Runs a command: its result, or an error with the message of Upstash. */
  const run = async (command: string[]) => {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(command),
    })
    const body = (await response.json().catch(() => undefined)) as
      { result?: unknown; error?: unknown } | undefined
    if (!response.ok || typeof body?.error === 'string' || !body) {
      const detail =
        typeof body?.error === 'string' ? body.error : response.statusText
      throw new Error(`Upstash: ${response.status} ${detail}`.trim())
    }
    return body.result
  }

  const px = (ttl: number) => String(Math.ceil(ttl))

  return Object.freeze({
    name,
    get: async (key: string) => valueOf(await run(['GET', key])),
    getMany: async (keys: readonly string[]) => {
      if (keys.length === 0) return []
      const result = await run(['MGET', ...keys])
      if (!Array.isArray(result) || result.length !== keys.length) {
        throw new TypeError('Unexpected result from Upstash to MGET.')
      }
      return result.map(valueOf)
    },
    set: async (key: string, value: string, ttl: number) => {
      await run(['SET', key, value, 'PX', px(ttl)])
    },
    delete: async (key: string) => {
      await run(['DEL', key])
    },
    lock: async (key: string, ttl: number) => {
      const lockToken = crypto.randomUUID()
      const result = await run(['SET', key, lockToken, 'NX', 'PX', px(ttl)])
      return result === 'OK' ? lockToken : undefined
    },
    unlock: async (key: string, lockToken: string) => {
      await run(['EVAL', UNLOCK, '1', key, lockToken])
    },
  })
}
