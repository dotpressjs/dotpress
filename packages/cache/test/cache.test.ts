import { createHash as nodeHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  CacheError,
  CacheStoreError,
  createCache,
  createMemoryStore,
  defineCacheEntry,
} from '../src/index.js'
import { createLogger, createSpyStore, storedOf } from './support.js'

afterEach(() => {
  vi.useRealTimers()
})

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.coerce.date(),
})
type User = z.infer<typeof userSchema>

const ada: User = {
  id: '42',
  name: 'Ada',
  createdAt: new Date('2026-11-10T10:00:00.000Z'),
}

const userCache = defineCacheEntry({
  name: 'user',
  key: (id: string) => id,
  schema: userSchema,
  ttl: '10m',
})

const createHash = (text: string) =>
  nodeHash('sha256').update(text).digest('hex')

/** A promise resolved from outside. */
const deferred = <T>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('cache.getOrSet()', () => {
  it('loads a missing value, caches it, then reads it', async () => {
    const store = createSpyStore()
    const cache = createCache({ store, prefix: 'app' })
    const load = vi.fn(async () => ada)

    expect(await cache.getOrSet(userCache, '42', load)).toEqual(ada)
    expect(await cache.getOrSet(userCache, '42', load)).toEqual(ada)
    expect(load).toHaveBeenCalledOnce()
    expect(store.set).toHaveBeenCalledExactlyOnceWith(
      'app:user:v1:42',
      expect.any(String),
      600_000
    )
    expect(await storedOf(store, 'app:user:v1:42')).toEqual({
      v: 1,
      c: expect.any(Number),
      e: expect.any(Number),
      d: JSON.stringify(ada),
    })
  })

  it('returns the value as it reads back: dates through the schema', async () => {
    const cache = createCache({ store: createMemoryStore() })
    const loaded = await cache.getOrSet(userCache, '42', async () => ada)
    const read = await cache.getOrSet(userCache, '42', async () => ada)
    expect(loaded.createdAt).toBeInstanceOf(Date)
    expect(read).toEqual(loaded)
    expect(read.createdAt).toBeInstanceOf(Date)
  })

  it('shares a load in progress (single flight)', async () => {
    const cache = createCache({ store: createMemoryStore() })
    const pending = deferred<User>()
    const load = vi.fn(() => pending.promise)
    const calls = [
      cache.getOrSet(userCache, '42', load),
      cache.getOrSet(userCache, '42', load),
      cache.withLogger(createLogger()).getOrSet(userCache, '42', load),
    ]
    await new Promise((resolve) => setTimeout(resolve, 5))
    pending.resolve(ada)
    expect(await Promise.all(calls)).toEqual([ada, ada, ada])
    expect(load).toHaveBeenCalledOnce()
  })

  it('shares failures in progress, without caching them', async () => {
    const cache = createCache({ store: createMemoryStore() })
    const load = vi
      .fn<() => Promise<User>>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(ada)
    const calls = [
      cache.getOrSet(userCache, '42', load),
      cache.getOrSet(userCache, '42', load),
    ]
    for (const call of calls)
      await expect(call).rejects.toThrow('database down')
    expect(await cache.getOrSet(userCache, '42', load)).toEqual(ada)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('loads again once the value expired', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] })
    const cache = createCache({ store: createMemoryStore() })
    const load = vi.fn(async () => ada)
    await cache.getOrSet(userCache, '42', load)
    vi.setSystemTime(599_999)
    await cache.getOrSet(userCache, '42', load)
    expect(load).toHaveBeenCalledOnce()
    vi.setSystemTime(600_000)
    await cache.getOrSet(userCache, '42', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('ignores expired entries that the store still returns', async () => {
    const store = createSpyStore()
    const cache = createCache({ store })
    const expired = JSON.stringify({
      v: 1,
      c: 0,
      e: Date.now() - 1,
      d: JSON.stringify(ada),
    })
    await store.memory.set('user:v1:42', expired, 60_000)
    const load = vi.fn(async () => ada)
    await cache.getOrSet(userCache, '42', load)
    expect(load).toHaveBeenCalledOnce()
  })

  it('does not cache undefined', async () => {
    const store = createSpyStore()
    const settings = defineCacheEntry({ name: 'settings' })
    const cache = createCache({ store })
    const load = vi.fn(async () => undefined)
    const logger = createLogger()
    expect(
      await cache.withLogger(logger).getOrSet(settings, load)
    ).toBeUndefined()
    expect(logger.entries.filter(({ level }) => level !== 'debug')).toEqual([])
    expect(await cache.getOrSet(settings, load)).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(2)
    expect(store.set).not.toHaveBeenCalled()
    const nothing = vi.fn(async () => null)
    await cache.getOrSet(settings, nothing)
    expect(await cache.getOrSet(settings, nothing)).toBeNull()
    expect(nothing).toHaveBeenCalledOnce()
  })

  it('returns the value as the schema reads it, defaults included', async () => {
    const tagged = defineCacheEntry({
      name: 'tagged',
      schema: z.object({ tags: z.array(z.string()).default([]) }),
    })
    const cache = createCache({ store: createMemoryStore() })
    expect(
      await cache.getOrSet(tagged, async () => ({}) as { tags: string[] })
    ).toEqual({ tags: [] })
  })

  it('treats an entry as expired at its expiry time', async () => {
    vi.useFakeTimers({ now: 1000, toFake: ['Date'] })
    const store = createSpyStore()
    const cache = createCache({ store })
    const entry = (e: number) =>
      JSON.stringify({ v: 1, c: 0, e, d: JSON.stringify(ada) })
    await store.memory.set('user:v1:42', entry(1001), 60_000)
    expect(await cache.get(userCache, '42')).toEqual(ada)
    await store.memory.set('user:v1:42', entry(1000), 60_000)
    expect(await cache.get(userCache, '42')).toBeUndefined()
    // Still readable for the grace period, but not fresh.
    expect(
      await createCache({ store, grace: '1h' }).get(userCache, '42')
    ).toBeUndefined()
  })

  it('needs a loader', async () => {
    const cache = createCache({ store: createMemoryStore() })
    const getOrSet = cache.getOrSet as (...args: unknown[]) => Promise<unknown>
    await expect(getOrSet(userCache, '42')).rejects.toThrow(
      new TypeError(
        'cache.getOrSet(): the last argument must be the function that loads the value.'
      )
    )
  })
})

describe('schema', () => {
  it('ignores stored values that do not match the schema', async () => {
    const store = createSpyStore()
    const logger = createLogger()
    const cache = createCache({ store, logger })
    await store.memory.set(
      'user:v1:42',
      JSON.stringify({
        v: 1,
        c: 0,
        e: Date.now() + 60_000,
        d: JSON.stringify({ id: 42 }),
      }),
      60_000
    )
    expect(await cache.get(userCache, '42')).toBeUndefined()
    expect(await cache.getOrSet(userCache, '42', async () => ada)).toEqual(ada)
    expect(await cache.get(userCache, '42')).toEqual(ada)
  })

  it('does not cache values that do not read back', async () => {
    const strictDate = defineCacheEntry({
      name: 'event',
      schema: z.object({ at: z.date() }), // JSON turns dates into strings
    })
    const store = createSpyStore()
    const logger = createLogger()
    const cache = createCache({ store, logger })
    const value = { at: new Date() }
    expect(await cache.getOrSet(strictDate, async () => value)).toBe(value)
    expect(store.set).not.toHaveBeenCalled()
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'Cache value does not match the schema of the entry: not cached',
      data: { entry: 'event', key: 'event:v1' },
    })
    await cache.set(strictDate, value)
    expect(store.set).not.toHaveBeenCalled()
  })

  it('ignores entries that are not entries of this cache', async () => {
    const store = createSpyStore()
    const cache = createCache({ store })
    for (const text of [
      'not json',
      'null',
      '{"v":2,"c":0,"e":9999999999999,"d":"1"}',
      '{"v":1,"c":"0","e":9999999999999,"d":"1"}',
      '{"v":1,"c":0,"e":"9999999999999","d":"1"}',
      '{"v":1,"c":0,"e":9999999999999,"d":1}',
      '{"v":1,"c":0,"e":9999999999999,"d":"1","t":null}',
      '{"v":1,"c":0,"e":9999999999999,"d":"1","t":"x"}',
    ]) {
      await store.memory.set('settings:v1', text, 60_000)
      expect(
        await cache.get(defineCacheEntry({ name: 'settings' }))
      ).toBeUndefined()
    }
  })
})

describe('keys', () => {
  it('builds keys from the prefix, the name, the version and the key', async () => {
    const store = createSpyStore()
    const plain = createCache({ store })
    const prefixed = createCache({ store, prefix: 'shop' })
    const product = defineCacheEntry({
      name: 'product',
      key: (sku: string, locale: string) => `${sku}:${locale}`,
      version: 3,
    })
    const byNumber = defineCacheEntry({
      name: 'order',
      key: (id: number) => id,
    })
    const byObject = defineCacheEntry({
      name: 'search',
      key: (query: string, page: number) => ({ query, page }),
    })
    const byArgs = defineCacheEntry({ name: 'args' })
    const settings = defineCacheEntry({ name: 'settings', version: 0 })

    await plain.set(product, 'A1', 'fr', 'Chaise')
    await prefixed.set(product, 'A1', 'fr', 'Chaise')
    await plain.set(byNumber, 7, 'paid')
    await plain.set(byObject, 'chair', 2, ['A1'])
    await plain.set(byArgs, 'one', 1)
    await plain.set(byArgs, 'a', 2, 2)
    await plain.set(byArgs, { b: 2, a: 1 }, 3)
    await plain.set(settings, { theme: 'dark' })
    expect(store.set.mock.calls.map(([key]) => key)).toEqual([
      'product:v3:A1:fr',
      'shop:product:v3:A1:fr',
      'order:v1:7',
      'search:v1:{"page":2,"query":"chair"}',
      'args:v1:one',
      'args:v1:["a",2]',
      'args:v1:{"a":1,"b":2}',
      'settings:v0',
    ])
    expect(await plain.get(byArgs, { a: 1, b: 2 })).toBe(3)
  })

  it('hashes keys longer than the store accepts', async () => {
    const store = { ...createSpyStore(), maxKeyLength: 40 }
    const cache = createCache({ store, prefix: 'app' })
    const fits = 'é'.repeat(14) // app:user:v1: (12) + 28 bytes = 40 bytes
    const long = `${fits}x`
    await cache.set(userCache, fits, ada)
    await cache.set(userCache, long, ada)
    const [kept, hashed] = store.set.mock.calls.map(([key]) => key)
    expect(kept).toBe(`app:user:v1:${fits}`)
    expect(hashed).toBe(`app:user:v1:#${createHash(long)}`)
    expect(await cache.get(userCache, long)).toEqual(ada)
  })

  it('keys entries without arguments by their key option', async () => {
    const store = createSpyStore()
    const all = defineCacheEntry({ name: 'all', key: () => 'everything' })
    await createCache({ store }).set(all, [1, 2])
    expect(store.set.mock.calls[0]?.[0]).toBe('all:v1:everything')
  })

  it('refuses arguments that cannot be keyed', async () => {
    const byArgs = defineCacheEntry({ name: 'args' })
    const cache = createCache({ store: createMemoryStore() })
    await expect(cache.get(byArgs, () => 1)).rejects.toThrow(
      'Cache entry "args": cannot build a key from a function; add a key option that returns a string.'
    )
  })

  it('ignores the values of other versions', async () => {
    const store = createMemoryStore()
    const cache = createCache({ store })
    const v1 = defineCacheEntry({ name: 'profile', key: (id: string) => id })
    const v2 = defineCacheEntry({
      name: 'profile',
      key: (id: string) => id,
      version: 2,
    })
    await cache.set(v1, '42', 'old')
    expect(await cache.get(v2, '42')).toBeUndefined()
  })
})

describe('cache.get(), set() and delete()', () => {
  it('reads, writes and removes values', async () => {
    const logger = createLogger()
    const cache = createCache({ store: createMemoryStore(), logger })
    expect(await cache.get(userCache, '42')).toBeUndefined()
    await cache.set(userCache, '42', ada)
    expect(await cache.get(userCache, '42')).toEqual(ada)
    await cache.delete(userCache, '42')
    expect(await cache.get(userCache, '42')).toBeUndefined()
    expect(logger.entries.map(({ message }) => message)).toEqual([
      'Cache miss',
      'Cache hit',
      'Cache miss',
    ])
    expect(logger.entries[1]?.data).toEqual({
      entry: 'user',
      key: 'user:v1:42',
    })
  })

  it('logs hits and misses of getOrSet()', async () => {
    const logger = createLogger()
    const cache = createCache({ store: createMemoryStore(), logger })
    await cache.getOrSet(userCache, '42', async () => ada)
    await cache.getOrSet(userCache, '42', async () => ada)
    expect(logger.entries).toEqual([
      {
        level: 'debug',
        message: 'Cache miss',
        data: { entry: 'user', key: 'user:v1:42' },
      },
      {
        level: 'debug',
        message: 'Cache hit',
        data: { entry: 'user', key: 'user:v1:42' },
      },
    ])
  })

  it('uses the ttl of the entry, else the ttl of the cache (1 hour by default)', async () => {
    const store = createSpyStore()
    const plain = defineCacheEntry({ name: 'plain' })
    await createCache({ store }).set(plain, 1)
    await createCache({ store, ttl: 30 }).set(plain, 1)
    await createCache({ store, ttl: '2h' }).set(userCache, '42', ada)
    expect(store.set.mock.calls.map(([, , ttl]) => ttl)).toEqual([
      3_600_000, 30_000, 600_000,
    ])
    const stored = (await storedOf(store, 'user:v1:42')) as {
      c: number
      e: number
    }
    expect(stored.e - stored.c).toBe(600_000)
  })

  it('logs values that cannot be serialized or deserialized, without caching them', async () => {
    const store = createSpyStore()
    const logger = createLogger()
    const cache = createCache({ store, logger })
    const plain = defineCacheEntry({ name: 'plain' })
    await cache.set(plain, { size: 1n })
    expect(store.set).not.toHaveBeenCalled()
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'Cache value cannot be serialized',
      data: {
        entry: 'plain',
        key: 'plain:v1',
        error: expect.stringContaining('BigInt'),
      },
    })
    await cache.set(plain, () => 1) // JSON.stringify gives undefined
    expect(store.set).not.toHaveBeenCalled()
    expect(logger.entries.at(-1)).toMatchObject({
      message: 'Cache value cannot be serialized',
      data: { error: 'not a string' },
    })

    await store.memory.set(
      'plain:v1',
      JSON.stringify({ v: 1, c: 0, e: Date.now() + 60_000, d: '{oops' }),
      60_000
    )
    expect(await cache.get(plain)).toBeUndefined()
    expect(logger.entries.at(-2)).toMatchObject({
      level: 'warn',
      message: 'Cache value cannot be deserialized',
      data: { entry: 'plain', key: 'plain:v1', error: expect.any(String) },
    })
  })

  it('uses a custom serializer', async () => {
    const store = createSpyStore()
    const serializer = {
      serialize: vi.fn((value: unknown) => `<${JSON.stringify(value)}>`),
      deserialize: vi.fn(
        (text: string) => JSON.parse(text.slice(1, -1)) as unknown
      ),
    }
    const cache = createCache({ store, serializer })
    const plain = defineCacheEntry({ name: 'plain' })
    await cache.set(plain, { a: 1 })
    expect(await cache.get(plain)).toEqual({ a: 1 })
    expect(((await storedOf(store, 'plain:v1')) as { d: string }).d).toBe(
      '<{"a":1}>'
    )
    // Without schema, a written value is not read back.
    expect(serializer.deserialize).toHaveBeenCalledOnce()
  })

  it('refuses entries it did not create', async () => {
    const cache = createCache({ store: createMemoryStore() })
    const fake = { name: 'user', version: 1 } as never
    for (const method of ['get', 'set', 'delete', 'getOrSet'] as const) {
      await expect(
        (cache[method] as (entry: unknown) => Promise<unknown>)(fake)
      ).rejects.toThrow(
        `cache.${method}(): expected an entry created by defineCacheEntry().`
      )
    }
    await expect(cache.get(null as never)).rejects.toThrow('expected an entry')
  })
})

describe('store failures', () => {
  const failing = () =>
    createSpyStore({
      get: vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
      set: vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
      delete: vi.fn(async () => {
        throw 'timeout'
      }),
    })

  it('fail open by default, logged and reported', async () => {
    const store = failing()
    const logger = createLogger()
    const onError = vi.fn()
    const cache = createCache({ store, logger, onError })
    const load = vi.fn(async () => ada)

    expect(await cache.getOrSet(userCache, '42', load)).toEqual(ada)
    expect(await cache.get(userCache, '42')).toBeUndefined()
    await cache.delete(userCache, '42')

    const failures = logger.entries.filter(({ level }) => level !== 'debug')
    expect(failures).toEqual([
      {
        level: 'warn',
        message: 'Cache store failed',
        data: {
          store: 'spy',
          operation: 'get',
          key: 'user:v1:42',
          entry: 'user',
          error: 'Cache store "spy" failed to get "user:v1:42": ECONNREFUSED',
        },
      },
      expect.objectContaining({
        level: 'warn',
        data: expect.objectContaining({ operation: 'set' }),
      }),
      expect.objectContaining({
        level: 'warn',
        data: expect.objectContaining({ operation: 'get' }),
      }),
      {
        level: 'error',
        message: 'Cache store failed',
        data: {
          store: 'spy',
          operation: 'delete',
          key: 'user:v1:42',
          entry: 'user',
          error: 'Cache store "spy" failed to delete "user:v1:42": timeout',
        },
      },
    ])
    expect(onError).toHaveBeenCalledTimes(4)
    const [error, info] = onError.mock.calls[0] as [CacheStoreError, object]
    expect(error).toBeInstanceOf(CacheStoreError)
    expect(error).toBeInstanceOf(CacheError)
    expect(error).toMatchObject({
      name: 'CacheStoreError',
      store: 'spy',
      operation: 'get',
      key: 'user:v1:42',
      cause: new Error('ECONNREFUSED'),
    })
    expect(info).toEqual({ operation: 'get', key: 'user:v1:42', entry: 'user' })
  })

  it('logs the failures of onError and keeps going', async () => {
    const logger = createLogger()
    const cache = createCache({
      store: failing(),
      logger,
      onError: async () => {
        throw new Error('metrics down')
      },
    })
    expect(await cache.get(userCache, '42')).toBeUndefined()
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Cache onError hook failed',
      data: { error: 'metrics down' },
    })
    const other = createCache({
      store: failing(),
      logger,
      onError: () => {
        throw 'nope'
      },
    })
    await other.get(userCache, '42')
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Cache onError hook failed',
      data: { error: 'nope' },
    })
  })

  it('throw with failOpen: false', async () => {
    const load = vi.fn(async () => ada)
    const cache = createCache({ store: failing(), failOpen: false })
    await expect(cache.getOrSet(userCache, '42', load)).rejects.toThrow(
      CacheStoreError
    )
    expect(load).not.toHaveBeenCalled()
    await expect(cache.set(userCache, '42', ada)).rejects.toMatchObject({
      operation: 'set',
    })
    await expect(cache.delete(userCache, '42')).rejects.toMatchObject({
      operation: 'delete',
    })
  })

  it('count slow operations as failures with storeTimeout', async () => {
    const slow = createSpyStore({
      get: vi.fn(() => new Promise<undefined>(() => {})),
    })
    const logger = createLogger()
    const cache = createCache({ store: slow, logger, storeTimeout: '20ms' })
    const started = Date.now()
    expect(await cache.get(userCache, '42')).toBeUndefined()
    // 20 ms, not forever: a margin for busy CI runners.
    expect(Date.now() - started).toBeLessThan(2000)
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        data: expect.objectContaining({
          error:
            'Cache store "spy" failed to get "user:v1:42": no answer within 20 milliseconds',
        }),
      })
    )
    // Without storeTimeout, a slow store is awaited.
    const patient = createSpyStore()
    await patient.memory.set(
      'user:v1:42',
      JSON.stringify({
        v: 1,
        c: 0,
        e: Date.now() + 60_000,
        d: JSON.stringify(ada),
      }),
      60_000
    )
    patient.get.mockImplementation(
      (key) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(patient.memory.get(key)), 30)
        )
    )
    expect(await createCache({ store: patient }).get(userCache, '42')).toEqual(
      ada
    )
    // Fast operations are not affected.
    const fast = createCache({ store: createMemoryStore(), storeTimeout: 0.05 })
    await fast.set(userCache, '42', ada)
    expect(await fast.get(userCache, '42')).toEqual(ada)
  })
})

describe('defineCacheEntry()', () => {
  it('returns a frozen entry with its name and version', () => {
    expect(userCache).toEqual({ name: 'user', version: 1 })
    expect(Object.isFrozen(userCache)).toBe(true)
  })

  it('checks its options', () => {
    const define = (options: unknown) => () =>
      defineCacheEntry(options as never)
    expect(define(null)).toThrow(
      'defineCacheEntry(): expected an object of options.'
    )
    for (const name of [
      undefined,
      '',
      '-user',
      'a:b',
      'a b',
      'x'.repeat(129),
    ]) {
      expect(define({ name })).toThrow(
        'defineCacheEntry(): name must have 1 to 128 letters, digits, ".", "_" or "-", starting with a letter or a digit.'
      )
    }
    expect(define({ name: 'x'.repeat(128) })).not.toThrow()
    expect(define({ name: 'user', stale: 1 })).toThrow(
      'defineCacheEntry("user"): unknown option "stale".'
    )
    expect(define({ name: 'user', key: 'id' })).toThrow(
      'defineCacheEntry("user"): key must be a function.'
    )
    for (const schema of [{}, z.string().parse, null]) {
      expect(define({ name: 'user', schema })).toThrow(
        'defineCacheEntry("user"): schema must have a safeParseAsync() method, like a Zod schema.'
      )
    }
    for (const version of [-1, 1.5, '2']) {
      expect(define({ name: 'user', version })).toThrow(
        'defineCacheEntry("user"): version must be a non-negative integer.'
      )
    }
    for (const ttl of [-1, '10 minutes', '1y', null]) {
      expect(define({ name: 'user', ttl })).toThrow(
        `defineCacheEntry("user"): ttl must be a number of seconds, or a duration like '30s', '10m', '1h' or '7d'.`
      )
    }
    expect(define({ name: 'user', ttl: 0 })).toThrow(
      'defineCacheEntry("user"): ttl must be at least 1 millisecond.'
    )
    expect(define({ name: 'user', ttl: '1ms' })).not.toThrow()
  })
})

describe('createCache()', () => {
  it('checks its options', () => {
    const store = createMemoryStore()
    const create = (options: unknown) => () => createCache(options as never)
    const label = 'createCache()'
    expect(create(null)).toThrow(`${label}: expected an object of options.`)
    expect(create('memory')).toThrow(`${label}: expected an object of options.`)
    expect(create({ store, region: 'eu' })).toThrow(
      `${label}: unknown option "region".`
    )
    for (const invalid of [undefined, {}, { name: 'x', get() {}, set() {} }]) {
      expect(create({ store: invalid })).toThrow(
        `${label}: store must be a cache store (createMemoryStore(), createRedisStore()…).`
      )
    }
    for (const prefix of ['', 42]) {
      expect(create({ store, prefix })).toThrow(
        `${label}: prefix must be a non-empty string.`
      )
    }
    expect(create({ store, ttl: '1 hour' })).toThrow(
      `${label}: ttl must be a number of seconds`
    )
    expect(create({ store, ttl: 0 })).toThrow(
      `${label}: ttl must be at least 1 millisecond.`
    )
    for (const serializer of [null, {}, { serialize() {} }]) {
      expect(create({ store, serializer })).toThrow(
        `${label}: serializer must have serialize() and deserialize() methods.`
      )
    }
    expect(create({ store, onError: 'log' })).toThrow(
      `${label}: onError must be a function.`
    )
    expect(create({ store, failOpen: 'no' })).toThrow(
      `${label}: failOpen must be a boolean.`
    )
    expect(create({ store, storeTimeout: 0 })).toThrow(
      `${label}: storeTimeout must be at least 1 millisecond.`
    )
    expect(create({ store, logger: {} })).toThrow(
      `${label}: logger must have info(), warn() and error() methods.`
    )
    const cache = createCache({ store })
    expect(Object.isFrozen(cache)).toBe(true)
    expect(() => cache.withLogger({} as never)).toThrow(
      'withLogger(): logger must have info(), warn() and error() methods.'
    )
  })
})
