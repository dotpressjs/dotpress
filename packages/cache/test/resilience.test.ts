import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  CacheTimeoutError,
  createCache,
  createMemoryStore,
  defineCacheEntry,
  type CacheEvent,
} from '../src/index.js'
import { createLogger, createSpyStore } from './support.js'

afterEach(() => {
  vi.useRealTimers()
})

/** Date only: real timers keep working for timeouts. */
const useClock = (now = 0) => vi.useFakeTimers({ now, toFake: ['Date'] })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A promise resolved from outside. */
const deferred = <T>() => {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const setup = (options: Record<string, unknown> = {}) => {
  const store = createSpyStore()
  const logger = createLogger()
  const events: CacheEvent[] = []
  const cache = createCache({
    store,
    logger,
    onEvent: (event) => void events.push(event),
    ...options,
  })
  return { store, logger, events, cache }
}

const failing = () => Promise.reject(new Error('database down'))

describe('grace period (stale-if-error)', () => {
  const price = defineCacheEntry({
    name: 'price',
    key: (sku: string) => sku,
    ttl: 60,
    grace: '1h',
  })

  it('serves the expired value when the loader fails', async () => {
    useClock()
    const { cache, logger, events, store } = setup()
    await cache.getOrSet(price, 'A1', () => 10)
    expect(store.set.mock.calls[0]?.[2]).toBe(60_000 + 3_600_000)

    vi.setSystemTime(61_000)
    expect(await cache.getOrSet(price, 'A1', failing)).toBe(10)
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'Cache served a stale value: the loader failed',
      data: { entry: 'price', key: 'price:v1:A1', error: 'database down' },
    })
    expect(events.map(({ type, reason }) => [type, reason])).toEqual([
      ['miss', undefined],
      ['miss', undefined],
      ['stale', 'error'],
    ])
    // get() only returns fresh values.
    expect(await cache.get(price, 'A1')).toBeUndefined()
  })

  it('fails past the grace period, or without stale value', async () => {
    useClock()
    const { cache } = setup()
    await expect(cache.getOrSet(price, 'B2', failing)).rejects.toThrow(
      'database down'
    )
    await cache.getOrSet(price, 'A1', () => 10)
    vi.setSystemTime(60_000 + 3_600_000)
    await expect(cache.getOrSet(price, 'A1', failing)).rejects.toThrow(
      'database down'
    )
  })

  it('does not call the loader again during the backoff', async () => {
    useClock()
    const { cache, events } = setup()
    await cache.getOrSet(price, 'A1', () => 10)
    vi.setSystemTime(61_000)
    const loader = vi.fn(failing)
    expect(await cache.getOrSet(price, 'A1', loader)).toBe(10)
    vi.setSystemTime(70_999) // 10 seconds by default
    expect(await cache.getOrSet(price, 'A1', loader)).toBe(10)
    expect(loader).toHaveBeenCalledOnce()
    expect(events.at(-1)).toEqual({
      type: 'stale',
      reason: 'backoff',
      entry: 'price',
      key: 'price:v1:A1',
    })
    vi.setSystemTime(71_000)
    loader.mockResolvedValueOnce(12 as never)
    expect(await cache.getOrSet(price, 'A1', loader)).toBe(12)
    expect(loader).toHaveBeenCalledTimes(2)

    // A successful load ends the backoff.
    vi.setSystemTime(132_000)
    loader.mockRejectedValueOnce(new Error('down'))
    await cache.getOrSet(price, 'A1', loader)
    vi.setSystemTime(143_000)
    loader.mockResolvedValueOnce(13 as never)
    expect(await cache.getOrSet(price, 'A1', loader)).toBe(13)
  })

  it('ends the backoff after any successful load', async () => {
    useClock()
    const short = defineCacheEntry({ name: 'short', ttl: 1, grace: '1h' })
    const { cache } = setup()
    await cache.getOrSet(short, () => 1)
    vi.setSystemTime(1500)
    await cache.getOrSet(short, failing) // backoff until 11.5 s
    vi.setSystemTime(2000)
    await cache.delete(short)
    await cache.getOrSet(short, () => 2) // fresh until 3 s
    vi.setSystemTime(4000)
    const loader = vi.fn(() => 3)
    expect(await cache.getOrSet(short, loader)).toBe(3)
    expect(loader).toHaveBeenCalledOnce()
  })

  it('loads when the backoff outlives the grace period', async () => {
    useClock()
    const brief = defineCacheEntry({ name: 'brief', ttl: 60, grace: 2 })
    const { cache } = setup()
    await cache.getOrSet(brief, () => 1)
    vi.setSystemTime(61_000)
    expect(await cache.getOrSet(brief, failing)).toBe(1)
    vi.setSystemTime(63_000) // past the grace period, within the backoff
    expect(await cache.getOrSet(brief, () => 2)).toBe(2)
  })

  it('ends the grace period exactly, even with a longer stale-while-revalidate', async () => {
    useClock()
    const mixed = defineCacheEntry({
      name: 'mixed',
      ttl: 60,
      grace: 60,
      staleWhileRevalidate: 600,
      tags: () => ['t'],
    })
    const { cache } = setup()
    await cache.getOrSet(mixed, () => 1)
    await cache.invalidateTags(['t']) // no stale-while-revalidate anymore
    vi.setSystemTime(119_999)
    expect(await cache.getOrSet(mixed, failing)).toBe(1)
    vi.setSystemTime(120_000)
    await expect(cache.getOrSet(mixed, failing)).rejects.toThrow()
  })

  it('does not serve values past the grace period within stale-while-revalidate', async () => {
    const noGrace = defineCacheEntry({
      name: 'no-grace',
      staleWhileRevalidate: '1h',
      tags: () => ['t'],
    })
    const { cache } = setup()
    await cache.set(noGrace, 1)
    await cache.invalidateTags(['t'])
    await expect(cache.getOrSet(noGrace, failing)).rejects.toThrow(
      'database down'
    )
  })

  it('reports stale values in the debug log', async () => {
    useClock()
    const { cache, logger } = setup()
    await cache.getOrSet(price, 'A1', () => 10)
    vi.setSystemTime(61_000)
    await cache.getOrSet(price, 'A1', failing)
    expect(logger.entries).toContainEqual({
      level: 'debug',
      message: 'Cache served a stale value',
      data: { entry: 'price', key: 'price:v1:A1', reason: 'error' },
    })
  })

  it('uses graceBackoff', async () => {
    useClock()
    const quick = defineCacheEntry({
      name: 'quick',
      ttl: 60,
      grace: '1h',
      graceBackoff: '1s',
    })
    const { cache } = setup()
    await cache.getOrSet(quick, () => 1)
    vi.setSystemTime(61_000)
    await cache.getOrSet(quick, failing)
    vi.setSystemTime(62_000)
    const loader = vi.fn(() => 2)
    expect(await cache.getOrSet(quick, loader)).toBe(2)
  })

  it('takes the defaults of the cache, overridden by the entry', async () => {
    useClock()
    const plain = defineCacheEntry({ name: 'plain', ttl: 60 })
    const strict = defineCacheEntry({ name: 'strict', ttl: 60, grace: 0 })
    const { cache, store } = setup({ grace: '10m' })
    await cache.getOrSet(plain, () => 1)
    await cache.getOrSet(strict, () => 1)
    expect(store.set.mock.calls.map(([, , ttl]) => ttl)).toEqual([
      660_000, 60_000,
    ])
    vi.setSystemTime(61_000)
    expect(await cache.getOrSet(plain, failing)).toBe(1)
    await expect(cache.getOrSet(strict, failing)).rejects.toThrow()
  })
})

describe('stale-while-revalidate', () => {
  const rates = defineCacheEntry({
    name: 'rates',
    ttl: 60,
    staleWhileRevalidate: '5m',
  })

  it('serves the expired value, and refreshes it in the background', async () => {
    useClock()
    const { cache, events, store } = setup()
    await cache.getOrSet(rates, () => 1)
    expect(store.set.mock.calls[0]?.[2]).toBe(60_000 + 300_000)

    vi.setSystemTime(61_000)
    const refresh = deferred<number>()
    const loader = vi.fn(() => refresh.promise)
    expect(await cache.getOrSet(rates, loader)).toBe(1)
    expect(await cache.getOrSet(rates, loader)).toBe(1) // one refresh
    expect(loader).toHaveBeenCalledOnce()
    expect(events.at(-1)).toEqual({
      type: 'stale',
      reason: 'revalidate',
      entry: 'rates',
      key: 'rates:v1',
    })
    refresh.resolve(2)
    await vi.waitFor(async () => expect(await cache.get(rates)).toBe(2))
    expect(await cache.getOrSet(rates, loader)).toBe(2)
  })

  it('logs failed refreshes', async () => {
    useClock()
    const { cache, logger } = setup()
    await cache.getOrSet(rates, () => 1)
    vi.setSystemTime(61_000)
    expect(await cache.getOrSet(rates, failing)).toBe(1)
    await vi.waitFor(() =>
      expect(logger.entries).toContainEqual({
        level: 'warn',
        message: 'Cache refresh failed',
        data: { entry: 'rates', key: 'rates:v1', error: 'database down' },
      })
    )
  })

  it('ends the window exactly', async () => {
    useClock()
    const windowed = defineCacheEntry({
      name: 'windowed',
      ttl: 60,
      staleWhileRevalidate: 60,
      grace: '1h',
    })
    const { cache } = setup()
    await cache.getOrSet(windowed, () => 1)
    vi.setSystemTime(120_000) // expired at 60 s: the window just ended
    expect(await cache.getOrSet(windowed, () => 5)).toBe(5)
    await cache.set(windowed, 1)
    vi.setSystemTime(239_999) // expired at 180 s
    expect(await cache.getOrSet(windowed, () => 2)).toBe(1)
    await vi.waitFor(async () => expect(await cache.get(windowed)).toBe(2))
    vi.setSystemTime(400_000) // the value of 239.999 s expired at 299.999 s
    expect(await cache.getOrSet(windowed, () => 3)).toBe(3)
  })

  it('loads past the window', async () => {
    useClock()
    const { cache } = setup()
    await cache.getOrSet(rates, () => 1)
    vi.setSystemTime(360_000)
    expect(await cache.getOrSet(rates, () => 2)).toBe(2)
  })

  it('uses the larger window for the lifetime in the store', async () => {
    const both = defineCacheEntry({
      name: 'both',
      ttl: 60,
      grace: 120,
      staleWhileRevalidate: 30,
    })
    const { cache, store } = setup()
    await cache.set(both, 1)
    expect(store.set.mock.calls[0]?.[2]).toBe(180_000)
  })
})

describe('timeouts', () => {
  const report = defineCacheEntry({
    name: 'report',
    ttl: 60,
    grace: '1h',
    timeout: '20ms',
  })

  it('serves the stale value when the loader is slow, and caches its value later', async () => {
    useClock()
    const { cache, logger, events } = setup()
    await cache.getOrSet(report, () => 'v1')
    vi.setSystemTime(61_000)
    const slow = deferred<string>()
    const started = performance.now()
    expect(await cache.getOrSet(report, () => slow.promise)).toBe('v1')
    expect(performance.now() - started).toBeLessThan(1000)
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'Cache served a stale value: the loader is slow',
      data: { entry: 'report', key: 'report:v1', timeout: 20 },
    })
    expect(events.at(-1)).toMatchObject({ type: 'stale', reason: 'timeout' })
    slow.resolve('v2')
    await vi.waitFor(async () => expect(await cache.get(report)).toBe('v2'))
  })

  it('waits for a slow loader without stale value', async () => {
    const { cache } = setup()
    expect(
      await cache.getOrSet(report, async () => {
        await sleep(40)
        return 'v1'
      })
    ).toBe('v1')
  })

  it('logs a slow loader that fails after the timeout', async () => {
    useClock()
    const { cache, logger } = setup()
    await cache.getOrSet(report, () => 'v1')
    vi.setSystemTime(61_000)
    const slow = deferred<string>()
    await cache.getOrSet(report, () => slow.promise)
    slow.reject(new Error('gave up'))
    await vi.waitFor(() =>
      expect(logger.entries).toContainEqual({
        level: 'warn',
        message: 'Cache refresh failed',
        data: { entry: 'report', key: 'report:v1', error: 'gave up' },
      })
    )
  })

  it('fails after hardTimeout without stale value, and caches the value later', async () => {
    const strict = defineCacheEntry({
      name: 'strict',
      ttl: 60,
      grace: '1h',
      hardTimeout: '20ms',
    })
    const { cache } = setup()
    const slow = deferred<string>()
    const error = await cache
      .getOrSet(strict, () => slow.promise)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CacheTimeoutError)
    expect(error).toMatchObject({
      name: 'CacheTimeoutError',
      entry: 'strict',
      key: 'strict:v1',
      timeout: 20,
      message:
        'Cache entry "strict": the loader of "strict:v1" did not finish within 20 milliseconds.',
    })
    slow.resolve('late')
    await vi.waitFor(async () => expect(await cache.get(strict)).toBe('late'))
  })

  it('logs a load that fails after hardTimeout', async () => {
    const strict = defineCacheEntry({ name: 'strict', hardTimeout: '20ms' })
    const { cache, logger } = setup()
    const slow = deferred<string>()
    await expect(cache.getOrSet(strict, () => slow.promise)).rejects.toThrow(
      CacheTimeoutError
    )
    slow.reject(new Error('gave up'))
    await vi.waitFor(() =>
      expect(logger.entries).toContainEqual({
        level: 'warn',
        message: 'Cache refresh failed',
        data: { entry: 'strict', key: 'strict:v1', error: 'gave up' },
      })
    )
  })

  it('serves the stale value after hardTimeout', async () => {
    useClock()
    const strict = defineCacheEntry({
      name: 'strict',
      ttl: 60,
      grace: '1h',
      hardTimeout: '20ms',
    })
    const { cache, logger } = setup()
    await cache.getOrSet(strict, () => 'v1')
    vi.setSystemTime(61_000)
    expect(await cache.getOrSet(strict, () => new Promise(() => {}))).toBe('v1')
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: 'Cache served a stale value: the loader failed',
        data: expect.objectContaining({
          error:
            'Cache entry "strict": the loader of "strict:v1" did not finish within 20 milliseconds.',
        }),
      })
    )
  })

  it('does not wait for timers once the loader answered', async () => {
    const quick = defineCacheEntry({
      name: 'quick',
      grace: '1h',
      timeout: '1h',
      hardTimeout: '1h',
    })
    const { cache } = setup()
    const set = vi.spyOn(globalThis, 'setTimeout')
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    expect(await cache.getOrSet(quick, () => 1)).toBe(1)
    const timers = set.mock.results
      .filter((_, index) => set.mock.calls[index]?.[1] === 3_600_000)
      .map(({ value }) => value as unknown)
    // The soft timeout only runs with a stale value.
    expect(timers).toHaveLength(1)
    for (const timer of timers) expect(clear).toHaveBeenCalledWith(timer)

    useClock()
    await cache.set(quick, 1)
    vi.setSystemTime(Date.now() + 3_600_001) // expired, in its grace period
    set.mockClear()
    expect(await cache.getOrSet(quick, () => 2)).toBe(2)
    const both = set.mock.results
      .filter((_, index) => set.mock.calls[index]?.[1] === 3_600_000)
      .map(({ value }) => value as unknown)
    expect(both).toHaveLength(2)
    for (const timer of both) expect(clear).toHaveBeenCalledWith(timer)
    set.mockRestore()
    clear.mockRestore()
  })
})

describe('tags', () => {
  const product = defineCacheEntry({
    name: 'product',
    key: (id: string) => id,
    tags: (id: string) => [`product:${id}`, 'catalog'],
    grace: '1h',
  })
  const category = defineCacheEntry({
    name: 'category',
    key: (id: string) => id,
    tags: () => ['catalog'],
  })
  const unrelated = defineCacheEntry({
    name: 'unrelated',
    tags: () => ['other'],
  })

  it('expires the values of invalidated tags', async () => {
    const { cache, logger, store } = setup({ prefix: 'shop' })
    await cache.set(product, '1', 'chair')
    await cache.set(product, '2', 'table')
    await cache.set(category, 'c1', 'furniture')
    await cache.set(unrelated, 'kept')

    await cache.invalidateTags(['product:1'])
    expect(await cache.get(product, '1')).toBeUndefined()
    expect(await cache.get(product, '2')).toBe('table')
    expect(await cache.get(category, 'c1')).toBe('furniture')

    const sets = store.set.mock.calls.length
    await cache.invalidateTags(['catalog', 'catalog'])
    expect(store.set.mock.calls.length).toBe(sets + 1)
    expect(await cache.get(product, '2')).toBeUndefined()
    expect(await cache.get(category, 'c1')).toBeUndefined()
    expect(await cache.get(unrelated)).toBe('kept')
    expect(logger.entries).toContainEqual({
      level: 'debug',
      message: 'Cache tags invalidated',
      data: { tags: ['catalog', 'catalog'] },
    })

    // Loaded again, with the new token.
    const loader = vi.fn(() => 'armchair')
    expect(await cache.getOrSet(product, '1', loader)).toBe('armchair')
    expect(await cache.getOrSet(product, '1', loader)).toBe('armchair')
    expect(loader).toHaveBeenCalledOnce()
  })

  it('stores a token per tag, created once', async () => {
    const { cache, store } = setup({ prefix: 'shop' })
    await cache.set(product, '1', 'chair')
    await cache.set(product, '2', 'table')
    const tokenKeys = store.set.mock.calls
      .map(([key, , ttl]) => [key, ttl])
      .filter(([key]) => String(key).includes('_tag'))
    expect(tokenKeys).toEqual([
      ['shop:_tag:product:1', 30 * 86_400_000],
      ['shop:_tag:catalog', 30 * 86_400_000],
      ['shop:_tag:product:2', 30 * 86_400_000],
    ])
    const stored = JSON.parse(
      (await store.memory.get('shop:product:v1:1')) as string
    ) as { t: Record<string, string> }
    expect(stored.t).toEqual({
      'product:1': await store.memory.get('shop:_tag:product:1'),
      catalog: await store.memory.get('shop:_tag:catalog'),
    })
    const plain = createCache({ store })
    await plain.set(unrelated, 1)
    expect(store.set.mock.calls.at(-2)?.[0]).toBe('_tag:other')
  })

  it('serves invalidated values from the grace period, not from stale-while-revalidate', async () => {
    const both = defineCacheEntry({
      name: 'both',
      tags: () => ['t'],
      staleWhileRevalidate: '1h',
    })
    const { cache } = setup()
    await cache.set(product, '1', 'chair')
    await cache.set(both, 'old')
    await cache.invalidateTags(['catalog', 't'])
    expect(await cache.getOrSet(product, '1', failing)).toBe('chair')
    expect(await cache.getOrSet(both, () => 'new')).toBe('new')
  })

  it('treats unreadable tokens as invalid, and does not cache without them', async () => {
    const { cache, store, logger } = setup()
    await cache.set(product, '1', 'chair')
    const getMany = store.memory.getMany
    Object.assign(store, {
      getMany: vi.fn(async () => {
        throw new Error('ECONNRESET')
      }),
    })
    expect(await cache.get(product, '1')).toBeUndefined()
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        data: expect.objectContaining({
          operation: 'get',
          key: '_tag:product:1 _tag:catalog',
        }),
      })
    )
    const sets = store.set.mock.calls.length
    expect(await cache.getOrSet(product, '2', () => 'table')).toBe('table')
    expect(store.set.mock.calls.length).toBe(sets)
    Object.assign(store, { getMany })
  })

  it('reads tokens only for values with tags', async () => {
    const memory = createMemoryStore()
    const getMany = vi.fn(
      (keys: readonly string[]) =>
        memory.getMany?.(keys) as Promise<(string | undefined)[]>
    )
    const store = {
      name: 'grouped',
      get: (key: string) => memory.get(key),
      getMany,
      set: (key: string, value: string, ttl: number) =>
        memory.set(key, value, ttl),
      delete: (key: string) => memory.delete(key),
    }
    const cache = createCache({ store })
    await cache.set(unrelated, 1)
    getMany.mockClear()
    await cache.get(unrelated)
    expect(getMany).toHaveBeenCalledExactlyOnceWith(['_tag:other'])
    const plain = defineCacheEntry({ name: 'plain' })
    await cache.set(plain, 1)
    getMany.mockClear()
    await cache.get(plain)
    expect(getMany).not.toHaveBeenCalled()
  })

  it('keeps tokens as long as the values that use them', async () => {
    const lasting = defineCacheEntry({
      name: 'lasting',
      ttl: '60d',
      tags: () => ['archive'],
    })
    const { cache, store } = setup()
    await cache.set(lasting, 1)
    expect(store.set.mock.calls[0]).toEqual([
      '_tag:archive',
      expect.any(String),
      60 * 86_400_000,
    ])
  })

  it('returns the value as it reads back when tokens are unreadable', async () => {
    const tagged = defineCacheEntry({
      name: 'tagged',
      schema: z.object({ tags: z.array(z.string()).default([]) }),
      tags: () => ['t'],
    })
    const { cache, store } = setup()
    Object.assign(store, {
      getMany: vi.fn(async () => {
        throw new Error('ECONNRESET')
      }),
    })
    expect(
      await cache.getOrSet(tagged, () => ({}) as { tags: string[] })
    ).toEqual({ tags: [] })
  })

  it('reads tokens with get() when the store has no getMany()', async () => {
    const memory = createMemoryStore()
    const store = {
      name: 'basic',
      get: vi.fn((key: string) => memory.get(key)),
      set: (key: string, value: string, ttl: number) =>
        memory.set(key, value, ttl),
      delete: (key: string) => memory.delete(key),
    }
    const cache = createCache({ store })
    await cache.set(product, '1', 'chair')
    expect(await cache.get(product, '1')).toBe('chair')
    expect(store.get.mock.calls.map(([key]) => key)).toContain('_tag:catalog')
  })

  it('treats a missing token as an invalidation', async () => {
    const { cache, store } = setup()
    await cache.set(product, '1', 'chair')
    await store.memory.delete('_tag:catalog')
    expect(await cache.get(product, '1')).toBeUndefined()
  })

  it('logs failed invalidations as errors', async () => {
    const store = createSpyStore({
      set: vi.fn(async () => {
        throw new Error('READONLY')
      }),
    })
    const logger = createLogger()
    const onError = vi.fn()
    const cache = createCache({ store, logger, onError })
    await cache.invalidateTags(['catalog'])
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Cache store failed',
      data: {
        store: 'spy',
        operation: 'invalidate',
        key: '_tag:catalog',
        entry: 'tag:catalog',
        error:
          'Cache store "spy" failed to invalidate "_tag:catalog": READONLY',
      },
    })
    expect(onError.mock.calls[0]?.[1]).toEqual({
      operation: 'invalidate',
      key: '_tag:catalog',
      entry: 'tag:catalog',
    })
    await expect(
      createCache({ store, failOpen: false }).invalidateTags(['x'])
    ).rejects.toMatchObject({ operation: 'invalidate' })
  })

  it('checks tags', async () => {
    const { cache } = setup()
    for (const tags of ['catalog', [''], [1], null]) {
      await expect(cache.invalidateTags(tags as never)).rejects.toThrow(
        new TypeError(
          'cache.invalidateTags(): tags must be an array of non-empty strings.'
        )
      )
    }
    const broken = defineCacheEntry({
      name: 'broken',
      tags: () => 'x' as never,
    })
    await expect(cache.set(broken, 1)).rejects.toThrow(
      'defineCacheEntry("broken"): tags must be an array of non-empty strings.'
    )
    const none = defineCacheEntry({ name: 'none', tags: () => [] })
    await cache.set(none, 1)
    expect(await cache.get(none)).toBe(1)
    const { store } = setup()
    await createCache({ store }).set(none, 1)
    expect(await store.memory.get('none:v1')).not.toContain('"t"')
  })
})

describe('events', () => {
  it('reports hits and misses, and logs failing hooks', async () => {
    const logger = createLogger()
    const entry = defineCacheEntry({ name: 'counter' })
    const cache = createCache({
      store: createMemoryStore(),
      logger,
      onEvent: () => {
        throw new Error('metrics down')
      },
    })
    expect(await cache.getOrSet(entry, () => 1)).toBe(1)
    expect(await cache.getOrSet(entry, () => 2)).toBe(1)
    expect(logger.entries).toEqual([
      {
        level: 'debug',
        message: 'Cache miss',
        data: { entry: 'counter', key: 'counter:v1' },
      },
      {
        level: 'error',
        message: 'Cache onEvent hook failed',
        data: { error: 'metrics down' },
      },
      {
        level: 'debug',
        message: 'Cache hit',
        data: { entry: 'counter', key: 'counter:v1' },
      },
      {
        level: 'error',
        message: 'Cache onEvent hook failed',
        data: { error: 'metrics down' },
      },
    ])
  })
})

describe('options', () => {
  it('checks the durations of the policy', () => {
    for (const option of ['grace', 'graceBackoff', 'staleWhileRevalidate']) {
      expect(() =>
        defineCacheEntry({ name: 'x', [option]: '1 hour' } as never)
      ).toThrow(`defineCacheEntry("x"): ${option} must be a number of seconds`)
      expect(() =>
        defineCacheEntry({ name: 'x', [option]: 0 } as never)
      ).not.toThrow()
      expect(() =>
        createCache({ store: createMemoryStore(), [option]: -1 } as never)
      ).toThrow(`createCache(): ${option} must be a number of seconds`)
    }
    for (const option of ['timeout', 'hardTimeout']) {
      expect(() =>
        defineCacheEntry({ name: 'x', [option]: 0 } as never)
      ).toThrow(
        `defineCacheEntry("x"): ${option} must be at least 1 millisecond.`
      )
      expect(() =>
        createCache({ store: createMemoryStore(), [option]: '1s' } as never)
      ).not.toThrow()
    }
    expect(() => defineCacheEntry({ name: 'x', tags: ['a'] as never })).toThrow(
      'defineCacheEntry("x"): tags must be a function.'
    )
    expect(() =>
      createCache({ store: createMemoryStore(), onEvent: 'log' } as never)
    ).toThrow('createCache(): onEvent must be a function.')
  })
})
