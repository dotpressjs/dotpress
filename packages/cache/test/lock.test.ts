import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCache,
  createMemoryStore,
  defineCacheEntry,
} from '../src/index.js'
import { createLogger, createSpyStore } from './support.js'

afterEach(() => {
  vi.useRealTimers()
})

/** A promise resolved from outside. */
const deferred = <T>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const report = defineCacheEntry({ name: 'report', lock: '2s' })

describe('memory store locks', () => {
  it('lets one holder take a lock until it expires or is released', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] })
    const store = createMemoryStore()
    const token = await store.lock?.('a', 1000)
    expect(token).toEqual(expect.any(String))
    expect(await store.lock?.('a', 1000)).toBeUndefined()
    await store.unlock?.('a', 'other-token')
    expect(await store.lock?.('a', 1000)).toBeUndefined()
    await store.unlock?.('a', token as string)
    const again = await store.lock?.('a', 1000)
    expect(again).toEqual(expect.any(String))
    expect(again).not.toBe(token)
    vi.setSystemTime(1000)
    expect(await store.lock?.('a', 1000)).toEqual(expect.any(String))
    expect(await store.lock?.('b', 1000)).toEqual(expect.any(String))
    store.clear()
    expect(await store.lock?.('b', 1000)).toEqual(expect.any(String))
  })
})

describe('lock option', () => {
  it('loads once for every instance sharing the store', async () => {
    const store = createMemoryStore()
    // Two instances of the app: two caches on the same store.
    const first = createCache({ store })
    const second = createCache({ store })
    const pending = deferred<string>()
    const load = vi.fn(() => pending.promise)

    const a = first.getOrSet(report, load)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const b = second.getOrSet(report, load)
    await new Promise((resolve) => setTimeout(resolve, 60))
    pending.resolve('done')
    expect(await Promise.all([a, b])).toEqual(['done', 'done'])
    expect(load).toHaveBeenCalledOnce()
    // Released: the next load takes it at once.
    expect(await store.lock?.('report:v1:lock', 1000)).toEqual(
      expect.any(String)
    )
  })

  it('loads anyway when the lock is not released in time', async () => {
    const store = createMemoryStore()
    const logger = createLogger()
    const cache = createCache({ store, logger })
    const quick = defineCacheEntry({ name: 'quick', lock: '120ms' })
    await store.lock?.('quick:v1:lock', 10_000) // a crashed holder
    const started = Date.now()
    expect(await cache.getOrSet(quick, () => 'mine')).toBe('mine')
    expect(Date.now() - started).toBeGreaterThanOrEqual(110)
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'Cache lock not released in time: loading anyway',
      data: { entry: 'quick', key: 'quick:v1', lock: 120 },
    })
  })

  it('loads without lock when the store cannot take it', async () => {
    const unlock = vi.fn(async () => {})
    const store = createSpyStore({
      lock: vi.fn(async () => {
        throw new Error('NOSCRIPT')
      }),
      unlock,
    })
    const logger = createLogger()
    const cache = createCache({ store, logger })
    expect(await cache.getOrSet(report, () => 'value')).toBe('value')
    expect(unlock).not.toHaveBeenCalled()
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        data: expect.objectContaining({
          operation: 'lock',
          key: 'report:v1:lock',
        }),
      })
    )
  })

  it('releases the lock after a failed load, and logs failed releases', async () => {
    const memory = createMemoryStore()
    const unlock = vi.fn(async () => {
      throw new Error('READONLY')
    })
    const store = createSpyStore({
      lock: (key: string, ttl: number) =>
        memory.lock?.(key, ttl) as Promise<string | undefined>,
      unlock,
    })
    const logger = createLogger()
    const cache = createCache({ store, logger })
    await expect(
      cache.getOrSet(report, () => Promise.reject(new Error('down')))
    ).rejects.toThrow('down')
    expect(unlock).toHaveBeenCalledExactlyOnceWith(
      'report:v1:lock',
      expect.any(String)
    )
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        data: expect.objectContaining({ operation: 'unlock' }),
      })
    )
  })

  it('is ignored by stores without locks, and when not set', async () => {
    const store = createSpyStore()
    const lock = vi.fn(async () => 'token')
    const cache = createCache({ store })
    expect(await cache.getOrSet(report, () => 1)).toBe(1)
    const withLock = createCache({ store: { ...store, lock } })
    await withLock.getOrSet(defineCacheEntry({ name: 'plain' }), () => 1)
    expect(lock).not.toHaveBeenCalled()
    await createCache({ store: { ...store, lock }, lock: '1s' }).getOrSet(
      defineCacheEntry({ name: 'other' }),
      () => 1
    )
    expect(lock).toHaveBeenCalledExactlyOnceWith('other:v1:lock', 1000)
  })

  it('checks the duration', () => {
    expect(() => defineCacheEntry({ name: 'x', lock: 0 })).toThrow(
      'defineCacheEntry("x"): lock must be at least 1 millisecond.'
    )
  })
})
