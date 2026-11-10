import { expect, it, vi } from 'vitest'
import { createCache, defineCacheEntry, type CacheStore } from '../src/index.js'

/**
 * Tests every store must pass against a real server: values, expiry,
 * getMany, locks, and the cache with two instances.
 */
export const storeContract = (
  store: () => CacheStore,
  prefix = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
) => {
  it('gets, sets, expires and deletes values', async () => {
    await store().set(`${prefix}:a`, 'héllo ✓', 60_000)
    expect(await store().get(`${prefix}:a`)).toBe('héllo ✓')
    expect(await store().get(`${prefix}:missing`)).toBeUndefined()
    expect(
      await store().getMany?.([`${prefix}:a`, `${prefix}:missing`])
    ).toEqual(['héllo ✓', undefined])
    await store().delete(`${prefix}:a`)
    expect(await store().get(`${prefix}:a`)).toBeUndefined()
    await store().set(`${prefix}:short`, 'v', 50)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(await store().get(`${prefix}:short`)).toBeUndefined()
  })

  it('takes locks once, and releases them with their token', async () => {
    const key = `${prefix}:lock`
    const token = await store().lock?.(key, 5000)
    expect(token).toEqual(expect.any(String))
    expect(await store().lock?.(key, 5000)).toBeUndefined()
    await store().unlock?.(key, 'not-the-token')
    expect(await store().lock?.(key, 5000)).toBeUndefined()
    await store().unlock?.(key, token as string)
    expect(await store().lock?.(key, 50)).toEqual(expect.any(String))
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(await store().lock?.(key, 5000)).toEqual(expect.any(String))
  })

  it('runs the cache: tags, and one load for two instances', async () => {
    const product = defineCacheEntry({
      name: 'product',
      key: (id: string) => id,
      tags: (id: string) => [`product:${id}`],
      lock: '5s',
    })
    const first = createCache({ store: store(), prefix })
    const second = createCache({ store: store(), prefix })
    let release: (value: string) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    const a = first.getOrSet(product, '1', load)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const b = second.getOrSet(product, '1', load)
    await new Promise((resolve) => setTimeout(resolve, 80))
    release('chair')
    expect(await Promise.all([a, b])).toEqual(['chair', 'chair'])
    expect(load).toHaveBeenCalledOnce()

    await second.invalidateTags(['product:1'])
    expect(await first.get(product, '1')).toBeUndefined()
    expect(await first.getOrSet(product, '1', () => 'table')).toBe('table')
    expect(await second.get(product, '1')).toBe('table')
  })
}
