import { toMilliseconds, type Duration } from './duration.js'
import {
  CacheStoreError,
  CacheTimeoutError,
  type StoreOperation,
} from './errors.js'
import { keyOf } from './keys.js'
import { checkLogger, silentLogger, type CacheLogger } from './logger.js'
import { isStore, type CacheStore } from './store.js'

/**
 * A schema that validates cached values when they are read: a Zod schema,
 * or anything with the same `safeParseAsync()`.
 */
export interface CacheSchema<T> {
  safeParseAsync(
    value: unknown
  ): Promise<{ success: true; data: T } | { success: false }>
}

declare const untyped: unique symbol
/** Value type of an entry without schema: given by the loader. */
export interface Untyped {
  readonly [untyped]: true
}

declare const entryTypes: unique symbol

/** A kind of cached value, created by `defineCacheEntry()`. */
export interface CacheEntry<A extends readonly unknown[], T> {
  readonly name: string
  readonly version: number
  /** Types only. */
  readonly [entryTypes]?: { args: A; value: (value: T) => T }
}

/** Value of an entry: `unknown` without schema. */
export type CacheValue<T> = T extends Untyped ? unknown : T

/**
 * Lifetime and resilience of values: options of an entry, or defaults of
 * the cache.
 */
export interface CachePolicy {
  /** Lifetime of the values. Defaults to 1 hour. */
  ttl?: Duration | undefined
  /**
   * Stale-if-error: how long after expiry a value can still be served when
   * the loader fails (or times out). Defaults to 0 (disabled).
   */
  grace?: Duration | undefined
  /**
   * After a failed load served from the grace period, the loader is not
   * called again before this delay: the stale value is served. Defaults to
   * 10 seconds.
   */
  graceBackoff?: Duration | undefined
  /**
   * How long after expiry a value is still served while a background load
   * refreshes it. Defaults to 0 (disabled).
   */
  staleWhileRevalidate?: Duration | undefined
  /**
   * Soft timeout: a load slower than this serves the stale value of the
   * grace period, if any, and goes on in the background.
   */
  timeout?: Duration | undefined
  /**
   * Hard timeout: a load slower than this fails (`CacheTimeoutError`), or
   * serves the stale value of the grace period, if any. It goes on in the
   * background.
   */
  hardTimeout?: Duration | undefined
  /**
   * Distributed single flight: before loading a missing value, takes a
   * lock in the store (Redis…) for at most this duration; the other
   * instances wait for the value meanwhile, then load it themselves.
   * Ignored by stores without locks. Disabled by default.
   */
  lock?: Duration | undefined
}

/** Options of `defineCacheEntry()`. */
export interface CacheEntryOptions<
  A extends readonly unknown[],
  T,
> extends CachePolicy {
  /**
   * Name of the entry, in keys and logs: letters, digits, `.`, `_` and
   * `-`.
   */
  name: string
  /**
   * Key of the arguments: a string, a number, or a value compared like the
   * arguments of a memo. Defaults to the argument (or the arguments).
   */
  key?: ((...args: A) => unknown) | undefined
  /**
   * Validates cached values when they are read (entries from an older
   * version of the app) and written. JSON turns dates into strings: use
   * `z.coerce.date()`.
   */
  schema?: CacheSchema<T> | undefined
  /**
   * Version of the values, in the key: increase it when their shape
   * changes, to ignore the values written before. Defaults to 1.
   */
  version?: number | undefined
  /**
   * Tags of the arguments: `invalidateTags()` expires every value with one
   * of them.
   */
  tags?: ((...args: A) => readonly string[]) | undefined
}

/** A policy in milliseconds; undefined when not set. */
type Policy = { [K in keyof CachePolicy]: number | undefined }

interface EntryConfig {
  name: string
  version: number
  key: ((...args: readonly unknown[]) => unknown) | undefined
  schema: CacheSchema<unknown> | undefined
  tags: ((...args: readonly unknown[]) => readonly string[]) | undefined
  policy: Policy
}

const entries = new WeakMap<object, EntryConfig>()

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const POLICY = [
  'ttl',
  'grace',
  'graceBackoff',
  'staleWhileRevalidate',
  'timeout',
  'hardTimeout',
  'lock',
] as const
const ENTRY_OPTIONS = new Set([
  'name',
  'key',
  'schema',
  'version',
  'tags',
  ...POLICY,
])

/** Reads the durations of a policy (`ttl` and timeouts at least 1 ms). */
const policyOf = (label: string, values: Record<string, unknown>): Policy => {
  const policy: Policy = {}
  for (const option of POLICY) {
    const value = values[option]
    if (value === undefined) continue
    policy[option] =
      option === 'ttl' ||
      option === 'timeout' ||
      option === 'hardTimeout' ||
      option === 'lock'
        ? positive(`${label}: ${option}`, value)
        : toMilliseconds(`${label}: ${option}`, value)
  }
  return policy
}

/**
 * Defines a kind of cached value: its key, its lifetime, and optionally
 * its schema.
 *
 * ```ts
 * export const userCache = defineCacheEntry({
 *   name: 'user',
 *   key: (id: string) => id,
 *   schema: userSchema,
 *   ttl: '1h',
 * })
 * ```
 */
export function defineCacheEntry<A extends readonly unknown[], T>(
  options: CacheEntryOptions<A, T> & { schema: CacheSchema<T> }
): CacheEntry<A, T>
export function defineCacheEntry<A extends readonly unknown[]>(
  options: CacheEntryOptions<A, never> & { schema?: undefined }
): CacheEntry<A, Untyped>
export function defineCacheEntry<A extends readonly unknown[], T>(
  options: CacheEntryOptions<A, T>
): CacheEntry<A, T>
export function defineCacheEntry(options: unknown): {
  readonly name: string
  readonly version: number
} {
  const label = 'defineCacheEntry()'
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  const values = options as Record<string, unknown>
  const { name, key, schema, tags, version = 1 } = values
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(
      `${label}: name must have 1 to 128 letters, digits, ".", "_" or "-", starting with a letter or a digit.`
    )
  }
  const named = `defineCacheEntry("${name}")`
  for (const option of Object.keys(values)) {
    if (!ENTRY_OPTIONS.has(option)) {
      throw new TypeError(`${named}: unknown option "${option}".`)
    }
  }
  if (key !== undefined && typeof key !== 'function') {
    throw new TypeError(`${named}: key must be a function.`)
  }
  if (
    schema !== undefined &&
    typeof (schema as Partial<CacheSchema<unknown>> | null)?.safeParseAsync !==
      'function'
  ) {
    throw new TypeError(
      `${named}: schema must have a safeParseAsync() method, like a Zod schema.`
    )
  }
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new TypeError(`${named}: version must be a non-negative integer.`)
  }
  if (tags !== undefined && typeof tags !== 'function') {
    throw new TypeError(`${named}: tags must be a function.`)
  }

  const entry = Object.freeze({ name, version: version as number })
  entries.set(entry, {
    name,
    version: version as number,
    key: key as EntryConfig['key'],
    schema: schema as CacheSchema<unknown> | undefined,
    tags: tags as EntryConfig['tags'],
    policy: policyOf(named, values),
  })
  return entry
}

const positive = (label: string, value: unknown) => {
  const ms = toMilliseconds(label, value)
  if (ms < 1) throw new TypeError(`${label} must be at least 1 millisecond.`)
  return ms
}

/** Turns values into strings for the store, and back. */
export interface CacheSerializer {
  serialize(value: unknown): string
  deserialize(text: string): unknown
}

/** Details of a store failure, for `onError`. */
export interface CacheErrorInfo {
  readonly operation: StoreOperation
  /** Key of the store. */
  readonly key: string
  /** Name of the entry. */
  readonly entry: string
}

/** Something that happened to a value, for `onEvent`. */
export interface CacheEvent {
  /**
   * `hit`: fresh value; `miss`: loaded; `stale`: a value past its `ttl`
   * served, for the `reason`.
   */
  readonly type: 'hit' | 'miss' | 'stale'
  readonly reason?: 'revalidate' | 'error' | 'timeout' | 'backoff'
  /** Name of the entry. */
  readonly entry: string
  /** Key of the store. */
  readonly key: string
}

/** Options of `createCache()`: the policy is the default of the entries. */
export interface CacheOptions extends CachePolicy {
  store: CacheStore
  /** Prefix of every key, like the name of the app. */
  prefix?: string | undefined
  /** Defaults to JSON. */
  serializer?: CacheSerializer | undefined
  logger?: CacheLogger | undefined
  /**
   * Called for each store failure, besides the log: metrics, alerts. Its
   * own errors are logged and ignored.
   */
  onError?:
    | ((error: CacheStoreError, info: CacheErrorInfo) => void | Promise<void>)
    | undefined
  /**
   * When the store fails, behaves as a cache miss (reads) or ignores the
   * write, after logging it. Set false to throw a `CacheStoreError`.
   * Defaults to true.
   */
  failOpen?: boolean | undefined
  /** A store operation slower than this counts as a failure. */
  storeTimeout?: Duration | undefined
  /**
   * Called for each hit, miss and stale value served: metrics. Its errors
   * are logged and ignored.
   */
  onEvent?: ((event: CacheEvent) => void) | undefined
}

/** A cache, created by `createCache()`. */
export interface Cache {
  /**
   * The fresh value of the arguments, or undefined when missing, expired
   * or invalidated.
   */
  get<A extends readonly unknown[], T>(
    entry: CacheEntry<A, T>,
    ...args: A
  ): Promise<CacheValue<T> | undefined>
  /** Sets the value of the arguments (the last argument). */
  set<A extends readonly unknown[], T>(
    entry: CacheEntry<A, T>,
    ...argsAndValue: [...A, CacheValue<T>]
  ): Promise<void>
  /** Removes the value of the arguments. */
  delete<A extends readonly unknown[], T>(
    entry: CacheEntry<A, T>,
    ...args: A
  ): Promise<void>
  /**
   * The value of the arguments, loaded by the last argument when missing
   * and cached. Calls made while it loads share the load. Applies the
   * grace period, stale-while-revalidate and timeouts of the entry.
   *
   * A loader may return `undefined` (not found): it is not cached, and
   * `getOrSet` returns it.
   */
  getOrSet<A extends readonly unknown[], R>(
    entry: CacheEntry<A, Untyped>,
    ...argsAndLoader: [...A, () => R | Promise<R>]
  ): Promise<R>
  getOrSet<A extends readonly unknown[], T, R extends T | undefined = T>(
    entry: CacheEntry<A, T>,
    ...argsAndLoader: [...A, () => R | Promise<R>]
  ): Promise<[R] extends [T] ? T : T | undefined>
  /**
   * Expires every value with one of the tags (they can still be served by
   * the grace period when the loader fails).
   */
  invalidateTags(tags: readonly string[]): Promise<void>
  /** The same cache, logging with another logger. */
  withLogger(logger: CacheLogger): Cache
}

const CACHE_OPTIONS = new Set([
  'store',
  'prefix',
  'ttl',
  'serializer',
  'logger',
  'onError',
  'failOpen',
  'storeTimeout',
  'onEvent',
  ...POLICY,
])

const jsonSerializer: CacheSerializer = {
  serialize: (value) => JSON.stringify(value),
  deserialize: (text) => JSON.parse(text) as unknown,
}

/**
 * Stored form of a value: `{ v, c (created), e (expires), d (data),
 * t (token of each tag) }`.
 */
interface StoredEntry {
  v: 1
  c: number
  e: number
  d: string
  t?: Record<string, string>
}

const parseStored = (text: string): StoredEntry | undefined => {
  try {
    const stored = JSON.parse(text) as Partial<StoredEntry> | null
    if (
      stored?.v === 1 &&
      typeof stored.c === 'number' &&
      typeof stored.e === 'number' &&
      typeof stored.d === 'string' &&
      (stored.t === undefined ||
        (typeof stored.t === 'object' && stored.t !== null))
    ) {
      return stored as StoredEntry
    }
  } catch {
    // Not an entry of this cache.
  }
  return undefined
}

const encoder = new TextEncoder()

// Tokens of tags outlive the values that use them: 30 days at least.
const TAG_LIFETIME = 30 * 86_400_000
// While another instance holds the lock, the value is read again so often.
const LOCK_POLL = 50

/** SHA-256 of a text, in hexadecimal. */
const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Creates a cache on a store. Reads and writes fail open by default: a
 * store failure is logged (and passed to `onError`), and the app keeps
 * working without cache.
 *
 * ```ts
 * const cache = createCache({ store: createMemoryStore(), prefix: 'app', ttl: '10m' })
 * const user = await cache.getOrSet(userCache, id, () => db.users.findById(id))
 * ```
 */
export const createCache = (options: CacheOptions): Cache => {
  const label = 'createCache()'
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (!CACHE_OPTIONS.has(key)) {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  const {
    store,
    prefix,
    serializer = jsonSerializer,
    onError,
    onEvent,
    failOpen = true,
  } = options
  if (!isStore(store)) {
    throw new TypeError(
      `${label}: store must be a cache store (createMemoryStore(), createRedisStore()…).`
    )
  }
  if (prefix !== undefined && (typeof prefix !== 'string' || prefix === '')) {
    throw new TypeError(`${label}: prefix must be a non-empty string.`)
  }
  const defaults = policyOf(
    label,
    options as unknown as Record<string, unknown>
  )
  if (
    typeof serializer?.serialize !== 'function' ||
    typeof serializer.deserialize !== 'function'
  ) {
    throw new TypeError(
      `${label}: serializer must have serialize() and deserialize() methods.`
    )
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError(`${label}: onError must be a function.`)
  }
  if (onEvent !== undefined && typeof onEvent !== 'function') {
    throw new TypeError(`${label}: onEvent must be a function.`)
  }
  if (typeof failOpen !== 'boolean') {
    throw new TypeError(`${label}: failOpen must be a boolean.`)
  }
  const storeTimeout =
    options.storeTimeout === undefined
      ? undefined
      : positive(`${label}: storeTimeout`, options.storeTimeout)
  const rootLogger =
    options.logger === undefined
      ? silentLogger
      : checkLogger(label, options.logger)

  // Shared by every logger of the cache: loads in progress, and the end of
  // the backoff of the keys whose loader failed.
  const loading = new Map<string, Promise<unknown>>()
  const backoffs = new Map<string, number>()

  const configOf = (method: string, entry: unknown) => {
    const config =
      typeof entry === 'object' && entry !== null
        ? entries.get(entry)
        : undefined
    if (!config) {
      throw new TypeError(
        `cache.${method}(): expected an entry created by defineCacheEntry().`
      )
    }
    return config
  }

  /** Policy of an entry, with the defaults of the cache. */
  const policyFor = (config: EntryConfig) => {
    const value = (option: keyof CachePolicy) =>
      config.policy[option] ?? defaults[option]
    return {
      ttl: value('ttl') ?? 3_600_000,
      grace: value('grace') ?? 0,
      graceBackoff: value('graceBackoff') ?? 10_000,
      staleWhileRevalidate: value('staleWhileRevalidate') ?? 0,
      timeout: value('timeout'),
      hardTimeout: value('hardTimeout'),
      lock: value('lock'),
    }
  }

  /** A key of the store, hashed when longer than the store accepts. */
  const fit = async (base: string, part: string) => {
    const key = `${base}:${part}`
    return encoder.encode(key).length > (store.maxKeyLength ?? Infinity)
      ? `${base}:#${await sha256(part)}`
      : key
  }

  /** Key of the store for the arguments of an entry. */
  const keyFor = async (config: EntryConfig, args: readonly unknown[]) => {
    const raw = config.key
      ? config.key(...args)
      : args.length === 1
        ? args[0]
        : args
    const base = [prefix, config.name, `v${config.version}`]
      .filter((item) => item !== undefined)
      .join(':')
    if (!config.key && args.length === 0) return base
    return fit(
      base,
      typeof raw === 'string' ? raw : keyOf(`Cache entry "${config.name}"`, raw)
    )
  }

  /** Checks the tags returned by an entry, or given to invalidate. */
  const checkTags = (label: string, tags: unknown) => {
    if (
      !Array.isArray(tags) ||
      !tags.every((tag) => typeof tag === 'string' && tag !== '')
    ) {
      throw new TypeError(
        `${label}: tags must be an array of non-empty strings.`
      )
    }
    return [...new Set(tags as string[])]
  }

  /** Keys of the tokens of tags (`_` cannot start the name of an entry). */
  const tagKeysOf = (tags: readonly string[]) => {
    const base = prefix === undefined ? '_tag' : `${prefix}:_tag`
    return Promise.all(
      tags.map(async (tag) => ({ tag, key: await fit(base, tag) }))
    )
  }

  const create = (logger: CacheLogger): Cache => {
    const describe = (error: unknown) =>
      error instanceof Error ? error.message : String(error)

    /** Runs a store operation: failures are logged, and fail open. */
    const guard = async <R>(
      operation: StoreOperation,
      key: string,
      entry: string,
      run: () => Promise<R>,
      fallback: R
    ): Promise<R> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const running = run()
        return storeTimeout === undefined
          ? await running
          : await Promise.race([
              running,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(`no answer within ${storeTimeout} milliseconds`)
                    ),
                  storeTimeout
                )
              }),
            ])
      } catch (cause) {
        const error = new CacheStoreError(store.name, operation, key, {
          cause,
        })
        const data = {
          store: store.name,
          operation,
          key,
          entry,
          error: error.message,
        }
        // A failed deletion or invalidation may leave outdated values.
        if (operation === 'delete' || operation === 'invalidate') {
          logger.error(data, 'Cache store failed')
        } else {
          logger.warn(data, 'Cache store failed')
        }
        if (onError) {
          try {
            await onError(error, { operation, key, entry })
          } catch (hookError) {
            logger.error(
              { error: describe(hookError) },
              'Cache onError hook failed'
            )
          }
        }
        if (!failOpen) throw error
        return fallback
      } finally {
        clearTimeout(timer)
      }
    }

    /** Reports an event to the log (debug) and `onEvent`. */
    const report = (event: CacheEvent) => {
      const { type, reason, entry, key } = event
      logger.debug?.(
        { entry, key, ...(reason ? { reason } : {}) },
        type === 'hit'
          ? 'Cache hit'
          : type === 'miss'
            ? 'Cache miss'
            : 'Cache served a stale value'
      )
      if (!onEvent) return
      try {
        onEvent(event)
      } catch (error) {
        logger.error({ error: describe(error) }, 'Cache onEvent hook failed')
      }
    }

    /**
     * Current tokens of tags (undefined for a missing tag), or undefined
     * when the store cannot read them.
     */
    const tokensOf = async (
      entry: string,
      tagKeys: readonly { tag: string; key: string }[]
    ) => {
      const keys = tagKeys.map(({ key }) => key)
      const values = await guard<(string | undefined)[] | undefined>(
        'get',
        keys.join(' '),
        entry,
        () =>
          store.getMany
            ? store.getMany(keys)
            : Promise.all(keys.map((key) => store.get(key))),
        undefined
      )
      return values?.map((token, index) => ({
        tag: (tagKeys[index] as { tag: string }).tag,
        token,
      }))
    }

    /** Deserializes and validates a value: `{ value }`, or undefined. */
    const decode = async (config: EntryConfig, key: string, data: string) => {
      let value: unknown
      try {
        value = serializer.deserialize(data)
      } catch (error) {
        logger.warn(
          { entry: config.name, key, error: describe(error) },
          'Cache value cannot be deserialized'
        )
        return undefined
      }
      if (!config.schema) return { value }
      const result = await config.schema.safeParseAsync(value)
      return result.success ? { value: result.data } : undefined
    }

    /**
     * Reads a stored value: its value, expiry, and whether its tags are
     * still valid. Undefined when missing, invalid, or past every stale
     * window.
     */
    const lookup = async (
      config: EntryConfig,
      policy: ReturnType<typeof policyFor>,
      key: string
    ) => {
      const text = await guard(
        'get',
        key,
        config.name,
        () => store.get(key),
        undefined
      )
      if (text === undefined) return undefined
      const stored = parseStored(text)
      const now = Date.now()
      if (
        !stored ||
        stored.e + Math.max(policy.grace, policy.staleWhileRevalidate) <= now
      ) {
        return undefined
      }
      const decoded = await decode(config, key, stored.d)
      if (!decoded) return undefined
      const tags = Object.entries(stored.t ?? {})
      let tagsValid = true
      if (tags.length > 0) {
        const current = await tokensOf(
          config.name,
          await tagKeysOf(tags.map(([tag]) => tag))
        )
        // Unreadable tokens: the value may have been invalidated.
        tagsValid =
          current?.every(({ tag, token }) => token === stored.t?.[tag]) ?? false
      }
      return {
        value: decoded.value,
        expiresAt: stored.e,
        fresh: stored.e > now && tagsValid,
        tagsValid,
      }
    }

    /**
     * Writes a value, after checking that it reads back: returns the value
     * as read later, or undefined when it cannot be cached.
     */
    const write = async (
      config: EntryConfig,
      key: string,
      args: readonly unknown[],
      value: unknown
    ): Promise<{ value: unknown } | undefined> => {
      if (value === undefined) return undefined
      let data: string
      try {
        data = serializer.serialize(value)
        if (typeof data !== 'string') throw new TypeError('not a string')
      } catch (error) {
        logger.warn(
          { entry: config.name, key, error: describe(error) },
          'Cache value cannot be serialized'
        )
        return undefined
      }
      const checked = config.schema
        ? await decode(config, key, data)
        : { value }
      if (!checked) {
        logger.warn(
          { entry: config.name, key },
          'Cache value does not match the schema of the entry: not cached'
        )
        return undefined
      }
      const policy = policyFor(config)
      const lifetime =
        policy.ttl + Math.max(policy.grace, policy.staleWhileRevalidate)
      const now = Date.now()
      const stored: StoredEntry = {
        v: 1,
        c: now,
        e: now + policy.ttl,
        d: data,
      }
      if (config.tags) {
        const tags = checkTags(
          `defineCacheEntry("${config.name}")`,
          config.tags(...args)
        )
        if (tags.length > 0) {
          const tagKeys = await tagKeysOf(tags)
          const current = await tokensOf(config.name, tagKeys)
          // Unreadable tokens: creating new ones would invalidate every
          // value of these tags, so the value is not cached.
          if (!current) return checked
          stored.t = {}
          for (const [index, { tag, token }] of current.entries()) {
            if (token !== undefined) {
              stored.t[tag] = token
              continue
            }
            // First value with this tag: its token is created.
            const created = crypto.randomUUID()
            const tagKey = (tagKeys[index] as { key: string }).key
            await guard(
              'set',
              tagKey,
              config.name,
              () =>
                store.set(tagKey, created, Math.max(lifetime, TAG_LIFETIME)),
              undefined
            )
            stored.t[tag] = created
          }
        }
      }
      await guard(
        'set',
        key,
        config.name,
        () => store.set(key, JSON.stringify(stored), lifetime),
        undefined
      )
      return checked
    }

    /**
     * Loads and writes a value, once per key at a time, and once for every
     * instance with the `lock` option.
     */
    const load = (
      config: EntryConfig,
      key: string,
      args: readonly unknown[],
      loader: () => unknown
    ) => {
      const running = loading.get(key)
      if (running) return running
      const loaded = (async () => {
        const policy = policyFor(config)
        const lockKey = `${key}:lock`
        let token: string | undefined
        if (policy.lock !== undefined && store.lock) {
          const lock = store.lock.bind(store)
          const ttl = policy.lock
          // null: the store failed, load without lock.
          const taken = await guard<string | undefined | null>(
            'lock',
            lockKey,
            config.name,
            () => lock(lockKey, ttl),
            null
          )
          if (taken === undefined) {
            // Another instance loads it: wait for its value.
            const until = Date.now() + ttl
            while (Date.now() < until) {
              await new Promise((resolve) => setTimeout(resolve, LOCK_POLL))
              const found = await lookup(config, policy, key)
              if (found?.fresh) return found.value
            }
            logger.warn(
              { entry: config.name, key, lock: ttl },
              'Cache lock not released in time: loading anyway'
            )
          } else if (taken !== null) {
            token = taken
          }
        }
        try {
          const value: unknown = await loader()
          const written = await write(config, key, args, value)
          backoffs.delete(key)
          return written ? written.value : value
        } finally {
          if (token !== undefined && store.unlock) {
            const unlock = store.unlock.bind(store)
            const held = token
            await guard(
              'unlock',
              lockKey,
              config.name,
              () => unlock(lockKey, held),
              undefined
            )
          }
        }
      })()
      loading.set(key, loaded)
      void loaded.then(
        () => loading.delete(key),
        () => loading.delete(key)
      )
      return loaded
    }

    /** Logs the failure of a load that nobody waits for anymore. */
    const inBackground = (
      config: EntryConfig,
      key: string,
      loaded: Promise<unknown>
    ) => {
      loaded.catch((error: unknown) => {
        logger.warn(
          { entry: config.name, key, error: describe(error) },
          'Cache refresh failed'
        )
      })
    }

    /** Rejects after `ms` (never when undefined), until cleared. */
    const deadline = (ms: number | undefined, error: () => unknown) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const promise = new Promise<never>((_, reject) => {
        if (ms !== undefined) timer = setTimeout(() => reject(error()), ms)
      })
      return { promise, clear: () => clearTimeout(timer) }
    }

    const cache: Cache = {
      get: (async (entry: unknown, ...args: unknown[]) => {
        const config = configOf('get', entry)
        const key = await keyFor(config, args)
        const found = await lookup(config, policyFor(config), key)
        report({ type: found?.fresh ? 'hit' : 'miss', entry: config.name, key })
        return found?.fresh ? found.value : undefined
      }) as Cache['get'],

      set: (async (entry: unknown, ...argsAndValue: unknown[]) => {
        const config = configOf('set', entry)
        const args = argsAndValue.slice(0, -1)
        const key = await keyFor(config, args)
        await write(config, key, args, argsAndValue.at(-1))
      }) as Cache['set'],

      delete: (async (entry: unknown, ...args: unknown[]) => {
        const config = configOf('delete', entry)
        const key = await keyFor(config, args)
        await guard(
          'delete',
          key,
          config.name,
          () => store.delete(key),
          undefined
        )
      }) as Cache['delete'],

      getOrSet: (async (entry: unknown, ...argsAndLoader: unknown[]) => {
        const config = configOf('getOrSet', entry)
        const loader = argsAndLoader.at(-1)
        if (typeof loader !== 'function') {
          throw new TypeError(
            'cache.getOrSet(): the last argument must be the function that loads the value.'
          )
        }
        const args = argsAndLoader.slice(0, -1)
        const key = await keyFor(config, args)
        const policy = policyFor(config)
        const found = await lookup(config, policy, key)
        const event = { entry: config.name, key }
        if (found?.fresh) {
          report({ type: 'hit', ...event })
          return found.value
        }
        const now = Date.now()

        // Stale-while-revalidate: serve, and refresh in the background.
        if (
          found?.tagsValid &&
          found.expiresAt + policy.staleWhileRevalidate > now
        ) {
          report({ type: 'stale', reason: 'revalidate', ...event })
          inBackground(
            config,
            key,
            load(config, key, args, loader as () => unknown)
          )
          return found.value
        }

        // Grace period: stale value served if the loader fails. Without it,
        // an invalidated value is never served.
        const stale =
          found && policy.grace > 0 && found.expiresAt + policy.grace > now
            ? found
            : undefined
        if (stale && (backoffs.get(key) ?? 0) > now) {
          report({ type: 'stale', reason: 'backoff', ...event })
          return stale.value
        }

        report({ type: 'miss', ...event })
        const loaded = load(config, key, args, loader as () => unknown)
        const slow = Symbol('slow')
        const soft = deadline(stale ? policy.timeout : undefined, () => slow)
        const hard = deadline(
          policy.hardTimeout,
          () =>
            new CacheTimeoutError(
              config.name,
              key,
              policy.hardTimeout as number
            )
        )
        try {
          return await Promise.race([loaded, soft.promise, hard.promise])
        } catch (error) {
          // The load goes on, and caches its value.
          if (error === slow || error instanceof CacheTimeoutError) {
            inBackground(config, key, loaded)
          }
          if (!stale) throw error
          if (error === slow) {
            logger.warn(
              { ...event, timeout: policy.timeout },
              'Cache served a stale value: the loader is slow'
            )
            report({ type: 'stale', reason: 'timeout', ...event })
            return stale.value
          }
          backoffs.set(key, Date.now() + policy.graceBackoff)
          logger.warn(
            { ...event, error: describe(error) },
            'Cache served a stale value: the loader failed'
          )
          report({ type: 'stale', reason: 'error', ...event })
          return stale.value
        } finally {
          soft.clear()
          hard.clear()
        }
      }) as Cache['getOrSet'],

      invalidateTags: async (tags) => {
        const tagKeys = await tagKeysOf(
          checkTags('cache.invalidateTags()', tags)
        )
        await Promise.all(
          tagKeys.map(({ tag, key }) =>
            guard(
              'invalidate',
              key,
              `tag:${tag}`,
              () => store.set(key, crypto.randomUUID(), TAG_LIFETIME),
              undefined
            )
          )
        )
        logger.debug?.({ tags }, 'Cache tags invalidated')
      },

      withLogger: (other) => create(checkLogger('withLogger()', other)),
    }
    return Object.freeze(cache)
  }

  return create(rootLogger)
}
