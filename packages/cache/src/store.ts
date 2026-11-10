/**
 * Where the cache keeps its entries: Redis, Upstash, Cloudflare KV,
 * memory… Values are strings, serialized by the cache.
 */
export interface CacheStore {
  /** Name of the store, in logs and errors. */
  readonly name: string
  /**
   * Longest key accepted, in bytes (UTF-8). Longer keys are hashed by the
   * cache. Undefined without limit.
   */
  readonly maxKeyLength?: number | undefined
  /** Value of a key, or undefined when it is missing or expired. */
  get(key: string): Promise<string | undefined>
  /**
   * Values of several keys, in their order: one round trip for the tags of
   * an entry. Optional: the cache calls `get` for each key without it.
   */
  getMany?(keys: readonly string[]): Promise<(string | undefined)[]>
  /** Sets a value that expires after `ttl` milliseconds (at least 1). */
  set(key: string, value: string, ttl: number): Promise<void>
  /** Removes a key; missing keys are ignored. */
  delete(key: string): Promise<void>
}

/** Checks a store option. */
export const isStore = (value: unknown): value is CacheStore => {
  const store = value as Partial<CacheStore> | null
  return (
    typeof store?.name === 'string' &&
    typeof store.get === 'function' &&
    typeof store.set === 'function' &&
    typeof store.delete === 'function'
  )
}

/** Options of `createMemoryStore()`. */
export interface MemoryStoreOptions {
  /**
   * Entries kept at most: the least recently used ones are removed
   * first. Defaults to 10,000.
   */
  maxEntries?: number | undefined
}

/** Store in the memory of the process: for one instance, and for tests. */
export interface MemoryStore extends CacheStore {
  /** Number of entries, expired ones included until they are read. */
  readonly size: number
  /** Removes every entry. */
  clear(): void
}

/**
 * Creates a store in the memory of the process, least recently used
 * entries removed first. Each instance has its own: use a shared store
 * (Redis…) for several instances.
 */
export const createMemoryStore = (
  options: MemoryStoreOptions = {}
): MemoryStore => {
  const label = 'createMemoryStore()'
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (key !== 'maxEntries') {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  const { maxEntries = 10_000 } = options
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError(`${label}: maxEntries must be a positive integer.`)
  }

  // Insertion order of a Map: the first entry is the least recently used.
  const entries = new Map<string, { value: string; expiresAt: number }>()

  const read = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return undefined
    entries.delete(key)
    if (entry.expiresAt <= Date.now()) return undefined
    entries.set(key, entry)
    return entry.value
  }

  return Object.freeze({
    name: 'memory',
    get size() {
      return entries.size
    },
    get: async (key: string) => read(key),
    getMany: async (keys: readonly string[]) => keys.map(read),
    set: async (key: string, value: string, ttl: number) => {
      entries.delete(key)
      entries.set(key, { value, expiresAt: Date.now() + ttl })
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break
        entries.delete(oldest)
      }
    },
    delete: async (key: string) => {
      entries.delete(key)
    },
    clear: () => {
      entries.clear()
    },
  })
}
