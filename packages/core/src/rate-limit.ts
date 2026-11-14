import { assertKnownOptions } from './options.js'

/** State of a rate limit counter. */
export interface RateLimitState {
  /** Number of hits in the current window, including the last one. */
  count: number
  /** End of the current window. */
  resetAt: Date
}

/**
 * Storage of rate limit counters (fixed windows), shared by the packages
 * that limit requests, like the login throttling of `@dotpress/auth`. Use a
 * shared store (Redis, database) when the app runs on several instances.
 */
export interface RateLimitStore {
  /**
   * Atomically increments the counter of a key and returns its state. A
   * missing or expired counter starts a new window of `windowSeconds`.
   */
  increment(key: string, windowSeconds: number): Promise<RateLimitState>
  /** Deletes the counter of a key. */
  reset(key: string): Promise<void>
}

export interface MemoryRateLimitStoreOptions {
  /**
   * Maximum number of counters kept in memory: expired counters are purged
   * first, then the oldest ones. Defaults to 10 000.
   */
  maxKeys?: number
}

const OPTIONS: ReadonlySet<string> = new Set([
  'maxKeys',
] satisfies (keyof MemoryRateLimitStoreOptions)[])

/**
 * In-memory rate limit store, for a single instance. With several
 * instances, each one counts on its own: use a shared store.
 */
export const createMemoryRateLimitStore = (
  options: MemoryRateLimitStoreOptions = {}
): RateLimitStore => {
  assertKnownOptions('createMemoryRateLimitStore()', options, OPTIONS)
  const maxKeys = options.maxKeys ?? 10_000
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError(
      'createMemoryRateLimitStore(): maxKeys must be a positive integer.'
    )
  }
  const counters = new Map<string, RateLimitState>()

  const makeRoom = (now: number) => {
    if (counters.size < maxKeys) return
    for (const [key, state] of counters) {
      if (state.resetAt.getTime() <= now) counters.delete(key)
    }
    // Map iteration follows insertion order: the oldest windows first.
    for (const key of counters.keys()) {
      if (counters.size < maxKeys) break
      counters.delete(key)
    }
  }

  return {
    async increment(key, windowSeconds) {
      const now = Date.now()
      const current = counters.get(key)
      if (current && current.resetAt.getTime() > now) {
        current.count += 1
        return { ...current }
      }

      counters.delete(key)
      makeRoom(now)
      const state = { count: 1, resetAt: new Date(now + windowSeconds * 1000) }
      counters.set(key, state)
      return { ...state }
    },

    async reset(key) {
      counters.delete(key)
    },
  }
}
