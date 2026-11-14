import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRateLimitStore } from '../src/index.js'

describe('createMemoryRateLimitStore()', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts hits in fixed windows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 0, 1))
    const store = createMemoryRateLimitStore()

    expect(await store.increment('a', 60)).toEqual({
      count: 1,
      resetAt: new Date(Date.UTC(2026, 0, 1, 0, 1)),
    })
    expect((await store.increment('a', 60)).count).toBe(2)
    expect((await store.increment('b', 60)).count).toBe(1)

    // The window does not slide with the hits.
    vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 0, 30))
    expect((await store.increment('a', 60)).count).toBe(3)
    vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 1))
    expect((await store.increment('a', 60)).count).toBe(1)

    await store.reset('a')
    expect((await store.increment('a', 60)).count).toBe(1)
  })

  it('bounds the number of counters, purging expired ones first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 0, 1))
    const store = createMemoryRateLimitStore({ maxKeys: 2 })

    await store.increment('long', 600)
    await store.increment('short', 10)
    vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 0, 30))
    await store.increment('new', 600)
    // `short` expired and was purged: `long`, older, is kept.
    expect((await store.increment('long', 600)).count).toBe(2)

    // Full of live counters: the oldest one is evicted.
    await store.increment('newer', 600)
    expect((await store.increment('long', 600)).count).toBe(1)
  })

  it('rejects an invalid size', () => {
    for (const maxKeys of [0, 1.5, -1]) {
      expect(() => createMemoryRateLimitStore({ maxKeys })).toThrow(
        new RangeError(
          'createMemoryRateLimitStore(): maxKeys must be a positive integer.'
        )
      )
    }
    expect(() => createMemoryRateLimitStore({ maxKey: 2 } as never)).toThrow(
      new TypeError('createMemoryRateLimitStore(): unknown option "maxKey".')
    )
  })
})
