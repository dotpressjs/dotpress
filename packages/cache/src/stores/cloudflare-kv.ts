import { parseDuration, type Duration } from '@dotpress/core'
import type { CacheStore } from '../store.js'

/** A Workers KV binding (the fields used here). */
export interface KvNamespace {
  get(
    key: string,
    options?: { type?: 'text'; cacheTtl?: number }
  ): Promise<string | null>
  get(
    keys: string[],
    options?: { type?: 'text'; cacheTtl?: number }
  ): Promise<Map<string, string | null>>
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>
  delete(key: string): Promise<void>
}

/** Options of `createCloudflareKvStore()`. */
export interface CloudflareKvStoreOptions {
  /**
   * The KV binding, or a function that returns it (with `env` imported
   * from `cloudflare:workers`, resolved on use).
   */
  kv: KvNamespace | (() => KvNamespace)
  /**
   * How long Cloudflare keeps read values in the cache of the location
   * (`cacheTtl` of `get`, at least 30 seconds): faster reads, but writes
   * and invalidations from other locations are seen later. Defaults to
   * the 60 seconds of KV.
   */
  cacheTtl?: Duration | undefined
  /** Name of the store, in logs and errors. Defaults to `cloudflare-kv`. */
  name?: string | undefined
}

// Limits of Workers KV: keys of 512 bytes, 100 keys per bulk read, and an
// expiration of 60 seconds at least.
const MAX_KEY_BYTES = 512
const MAX_BULK = 100
const MIN_EXPIRATION_TTL = 60

/**
 * Creates a store on [Workers KV](https://developers.cloudflare.com/kv),
 * through the binding of a Worker: no dependency. KV is eventually
 * consistent (a write can take 60 seconds or more to reach other
 * locations) and has no locks: a fit for values read often and changed
 * rarely.
 *
 * ```ts
 * import { env } from 'cloudflare:workers'
 *
 * const store = createCloudflareKvStore({ kv: () => env.CACHE })
 * ```
 */
export const createCloudflareKvStore = (
  options: CloudflareKvStoreOptions
): CacheStore => {
  const label = 'createCloudflareKvStore()'
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (!['kv', 'cacheTtl', 'name'].includes(key)) {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  const { kv, name = 'cloudflare-kv' } = options
  const isBinding = (value: unknown): value is KvNamespace =>
    typeof (value as KvNamespace | null)?.get === 'function' &&
    typeof (value as KvNamespace).put === 'function' &&
    typeof (value as KvNamespace).delete === 'function'
  if (typeof kv !== 'function' && !isBinding(kv)) {
    throw new TypeError(
      `${label}: kv must be a KV binding, or a function that returns it.`
    )
  }
  let cacheTtl: number | undefined
  if (options.cacheTtl !== undefined) {
    const ms = parseDuration(options.cacheTtl, `${label}: cacheTtl`)
    if (ms < 30_000) {
      throw new TypeError(`${label}: cacheTtl must be at least 30 seconds.`)
    }
    cacheTtl = Math.round(ms / 1000)
  }
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(`${label}: name must be a non-empty string.`)
  }

  const binding = () => {
    const value = typeof kv === 'function' ? kv() : kv
    if (!isBinding(value)) {
      throw new TypeError(`${label}: kv() must return a KV binding.`)
    }
    return value
  }
  const read = { type: 'text' as const, ...(cacheTtl ? { cacheTtl } : {}) }

  return Object.freeze({
    name,
    maxKeyLength: MAX_KEY_BYTES,
    get: async (key: string) => (await binding().get(key, read)) ?? undefined,
    getMany: async (keys: readonly string[]) => {
      const namespace = binding()
      const unique = [...new Set(keys)]
      const values = new Map<string, string | null>()
      for (let start = 0; start < unique.length; start += MAX_BULK) {
        const found = await namespace.get(
          unique.slice(start, start + MAX_BULK),
          read
        )
        for (const [key, value] of found) values.set(key, value)
      }
      return keys.map((key) => values.get(key) ?? undefined)
    },
    set: async (key: string, value: string, ttl: number) => {
      // The cache keeps the real expiry in the value; KV needs 60 s.
      await binding().put(key, value, {
        expirationTtl: Math.max(MIN_EXPIRATION_TTL, Math.ceil(ttl / 1000)),
      })
    },
    delete: async (key: string) => {
      await binding().delete(key)
    },
  })
}
