import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../src/index.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('createMemoryStore()', () => {
  it('gets, sets and deletes values', async () => {
    const store = createMemoryStore()
    expect(store.name).toBe('memory')
    expect(store.maxKeyLength).toBeUndefined()
    expect(await store.get('a')).toBeUndefined()
    await store.set('a', 'one', 1000)
    expect(await store.get('a')).toBe('one')
    await store.set('a', 'two', 1000)
    expect(await store.get('a')).toBe('two')
    await store.delete('a')
    await store.delete('missing')
    expect(await store.get('a')).toBeUndefined()
    expect(Object.isFrozen(store)).toBe(true)
  })

  it('expires values after their ttl', async () => {
    vi.useFakeTimers({ now: 0 })
    const store = createMemoryStore()
    await store.set('a', 'one', 1000)
    vi.setSystemTime(999)
    expect(await store.get('a')).toBe('one')
    vi.setSystemTime(1000)
    expect(await store.get('a')).toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('removes the least recently used entries beyond maxEntries', async () => {
    const store = createMemoryStore({ maxEntries: 2 })
    await store.set('a', '1', 1000)
    await store.set('b', '2', 1000)
    expect(await store.get('a')).toBe('1') // a is now the most recent
    await store.set('c', '3', 1000)
    expect(store.size).toBe(2)
    expect(await store.get('b')).toBeUndefined()
    expect(await store.get('a')).toBe('1')
    expect(await store.get('c')).toBe('3')
    await store.set('a', '4', 1000) // replacing a key does not evict
    expect(store.size).toBe(2)
    await store.set('c', '5', 1000) // and makes it the most recent
    await store.set('a', '6', 1000)
    await store.set('d', '7', 1000)
    expect(await store.get('c')).toBeUndefined()
    expect(await store.get('a')).toBe('6')
  })

  it('keeps 10,000 entries by default', async () => {
    const store = createMemoryStore()
    for (let index = 0; index <= 10_000; index += 1) {
      await store.set(`k${index}`, 'v', 1000)
    }
    expect(store.size).toBe(10_000)
    expect(await store.get('k0')).toBeUndefined()
    expect(await store.get('k1')).toBe('v')
  })

  it('clears every entry', async () => {
    const store = createMemoryStore()
    await store.set('a', '1', 1000)
    store.clear()
    expect(store.size).toBe(0)
  })

  it('checks its options', () => {
    const create = (options: unknown) => () =>
      createMemoryStore(options as never)
    expect(create(null)).toThrow(
      'createMemoryStore(): expected an object of options.'
    )
    expect(create('big')).toThrow(
      'createMemoryStore(): expected an object of options.'
    )
    expect(create({ max: 1 })).toThrow(
      'createMemoryStore(): unknown option "max".'
    )
    for (const maxEntries of [0, 1.5, '10']) {
      expect(create({ maxEntries })).toThrow(
        'createMemoryStore(): maxEntries must be a positive integer.'
      )
    }
    expect(create({ maxEntries: 1 })).not.toThrow()
  })
})
