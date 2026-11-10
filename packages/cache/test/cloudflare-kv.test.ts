import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCache, defineCacheEntry, type CacheStore } from '../src/index.js'
import {
  createCloudflareKvStore,
  type KvNamespace,
} from '../src/stores/cloudflare-kv.js'

/** A binding recording its calls, backed by a Map. */
const fakeKv = () => {
  const values = new Map<string, string>()
  const kv = {
    get: vi.fn<(key: string | string[], options?: object) => Promise<unknown>>(
      async (key) =>
        Array.isArray(key)
          ? new Map(key.map((item) => [item, values.get(item) ?? null]))
          : (values.get(key) ?? null)
    ),
    put: vi.fn<(key: string, value: string, options?: object) => Promise<void>>(
      async (key, value) => {
        values.set(key, value)
      }
    ),
    delete: vi.fn(async (key: string) => {
      values.delete(key)
    }),
  }
  return { kv, values, binding: kv as unknown as KvNamespace }
}

describe('createCloudflareKvStore() with a fake binding', () => {
  it('reads, writes and deletes values', async () => {
    const { kv, binding } = fakeKv()
    const store = createCloudflareKvStore({ kv: binding })
    expect(store.name).toBe('cloudflare-kv')
    expect(store.maxKeyLength).toBe(512)
    expect(store.lock).toBeUndefined()
    await store.set('a', 'one', 120_500)
    expect(await store.get('a')).toBe('one')
    expect(await store.get('missing')).toBeUndefined()
    await store.delete('a')
    expect(await store.get('a')).toBeUndefined()
    expect(kv.put).toHaveBeenCalledExactlyOnceWith('a', 'one', {
      expirationTtl: 121,
    })
    expect(kv.get.mock.calls[0]).toStrictEqual(['a', { type: 'text' }])
  })

  it('expires values after 60 seconds at least', async () => {
    const { kv, binding } = fakeKv()
    const store = createCloudflareKvStore({ kv: binding })
    await store.set('a', 'one', 1000)
    await store.set('b', 'two', 60_000)
    await store.set('c', 'three', 60_001)
    expect(kv.put.mock.calls.map(([, , options]) => options)).toEqual([
      { expirationTtl: 60 },
      { expirationTtl: 60 },
      { expirationTtl: 61 },
    ])
  })

  it('reads keys in bulk, 100 at a time', async () => {
    const { kv, values, binding } = fakeKv()
    for (let index = 0; index < 250; index += 1) {
      values.set(`k${index}`, `v${index}`)
    }
    const store = createCloudflareKvStore({ kv: binding })
    const keys = [
      ...Array.from({ length: 250 }, (_, index) => `k${index}`),
      'missing',
      'k0',
    ]
    const found = await store.getMany?.(keys)
    expect(found).toHaveLength(252)
    expect(found?.[0]).toBe('v0')
    expect(found?.[249]).toBe('v249')
    expect(found?.[250]).toBeUndefined()
    expect(found?.[251]).toBe('v0')
    const bulks = kv.get.mock.calls.map(([batch]) => (batch as string[]).length)
    expect(bulks).toEqual([100, 100, 51]) // without the duplicate
    expect(await store.getMany?.([])).toEqual([])
  })

  it('passes cacheTtl to reads', async () => {
    const { kv, binding } = fakeKv()
    const store = createCloudflareKvStore({ kv: binding, cacheTtl: '5m' })
    await store.get('a')
    await store.getMany?.(['a'])
    expect(kv.get.mock.calls.map(([, options]) => options)).toEqual([
      { type: 'text', cacheTtl: 300 },
      { type: 'text', cacheTtl: 300 },
    ])
  })

  it('resolves a binding given as a function on use', async () => {
    const { binding } = fakeKv()
    const resolve = vi.fn(() => binding)
    const store = createCloudflareKvStore({ kv: resolve, name: 'edge' })
    expect(store.name).toBe('edge')
    expect(resolve).not.toHaveBeenCalled()
    await store.set('a', '1', 1000)
    await store.get('a')
    expect(resolve).toHaveBeenCalledTimes(2)
    const broken = createCloudflareKvStore({ kv: () => ({}) as KvNamespace })
    await expect(broken.get('a')).rejects.toThrow(
      new TypeError('createCloudflareKvStore(): kv() must return a KV binding.')
    )
  })

  it('checks its options', () => {
    const label = 'createCloudflareKvStore()'
    const { binding } = fakeKv()
    const create = (options: unknown) => () =>
      createCloudflareKvStore(options as never)
    expect(create(null)).toThrow(`${label}: expected an object of options.`)
    expect(create('CACHE')).toThrow(`${label}: expected an object of options.`)
    expect(create({ kv: binding, namespace: 'x' })).toThrow(
      `${label}: unknown option "namespace".`
    )
    for (const kv of [
      undefined,
      {},
      { get() {}, put() {} },
      { get() {}, delete() {} },
      { put() {}, delete() {} },
    ]) {
      expect(create({ kv })).toThrow(
        `${label}: kv must be a KV binding, or a function that returns it.`
      )
    }
    expect(create({ kv: binding, cacheTtl: '29s' })).toThrow(
      `${label}: cacheTtl must be at least 30 seconds.`
    )
    expect(create({ kv: binding, cacheTtl: '30 s' })).toThrow(
      `${label}: cacheTtl must be a number of seconds`
    )
    expect(create({ kv: binding, cacheTtl: 30 })).not.toThrow()
    expect(create({ kv: binding, name: '' })).toThrow(
      `${label}: name must be a non-empty string.`
    )
    expect(Object.isFrozen(createCloudflareKvStore({ kv: binding }))).toBe(true)
  })
})

describe('Workers KV (Miniflare)', () => {
  let mf: Miniflare
  let store: CacheStore

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch: () => new Response("") }',
      kvNamespaces: ['CACHE'],
    })
    const kv = (await mf.getKVNamespace('CACHE')) as unknown as KvNamespace
    store = createCloudflareKvStore({ kv })
  }, 30_000)
  afterAll(() => mf.dispose())

  it('reads, writes, deletes and reads in bulk', async () => {
    await store.set('a', 'héllo ✓', 1000)
    expect(await store.get('a')).toBe('héllo ✓')
    const keys = Array.from({ length: 150 }, (_, index) => `bulk:${index}`)
    for (const key of keys.slice(0, 3)) await store.set(key, key, 60_000)
    const found = await store.getMany?.(['a', ...keys])
    expect(found?.slice(0, 5)).toEqual([
      'héllo ✓',
      'bulk:0',
      'bulk:1',
      'bulk:2',
      undefined,
    ])
    await store.delete('a')
    expect(await store.get('a')).toBeUndefined()
  })

  it('runs the cache: hashed keys, tags, expiry shorter than KV allows', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    try {
      const page = defineCacheEntry({
        name: 'page',
        key: (path: string) => path,
        tags: () => ['pages'],
        ttl: '10s',
      })
      const cache = createCache({ store, prefix: 'app' })
      const long = `/${'segment/'.repeat(80)}`
      expect(await cache.getOrSet(page, long, () => 'html')).toBe('html')
      expect(await cache.get(page, long)).toBe('html')
      vi.setSystemTime(Date.now() + 11_000) // expired for the cache
      expect(await cache.get(page, long)).toBeUndefined()
      expect(await cache.getOrSet(page, long, () => 'fresh')).toBe('fresh')
      await cache.invalidateTags(['pages'])
      expect(await cache.get(page, long)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
