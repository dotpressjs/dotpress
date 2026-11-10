import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  createCache,
  createMemo,
  createMemoryStore,
  defineCacheEntry,
  defineMemo,
  type CacheEntry,
  type MemoDefinition,
  type Untyped,
} from '../src/index.js'

interface User {
  id: string
  name: string
}
const findUser = async (id: string): Promise<User> => ({ id, name: 'Ada' })
const findUsers = async (ids: readonly string[]): Promise<Map<string, User>> =>
  new Map(ids.map((id) => [id, { id, name: 'Ada' }]))
const findOrders = async (ids: readonly number[]): Promise<(User | Error)[]> =>
  ids.map((id) => ({ id: String(id), name: 'Ada' }))

describe('types', () => {
  it('infers the arguments and the value of a load memo', () => {
    const loadUser = defineMemo({ name: 'user', load: findUser })
    expectTypeOf(loadUser).toEqualTypeOf<MemoDefinition<[id: string], User>>()
    const search = defineMemo({
      name: 'search',
      load: (query: string, page: number) => [query, page] as const,
    })
    const memo = createMemo()
    expectTypeOf(memo(loadUser, '1')).toEqualTypeOf<Promise<User>>()
    expectTypeOf(memo(search, 'ada', 2)).toEqualTypeOf<
      Promise<readonly [string, number]>
    >()
    // @ts-expect-error: the id is a string
    void memo(loadUser, 1)
    // @ts-expect-error: the page is missing
    void memo(search, 'ada')
  })

  it('infers the value of a batch memo', () => {
    const fromMap = defineMemo({ name: 'users', batch: findUsers })
    const fromArray = defineMemo({ name: 'orders', batch: findOrders })
    expectTypeOf(fromMap).toEqualTypeOf<
      MemoDefinition<[key: string], User | undefined>
    >()
    expectTypeOf(fromArray).toEqualTypeOf<MemoDefinition<[key: number], User>>()
    const memo = createMemo()
    expectTypeOf(memo(fromMap, '1')).toEqualTypeOf<Promise<User | undefined>>()
    // @ts-expect-error: one key per call
    void memo(fromArray, 1, 2)
  })

  it('checks the values set', () => {
    const loadUser = defineMemo({ name: 'user', load: findUser })
    const memo = createMemo()
    memo.set(loadUser, '1', { id: '1', name: 'Ada' })
    // @ts-expect-error: not a user
    memo.set(loadUser, '1', 'Ada')
    // @ts-expect-error: the id is missing
    memo.set(loadUser, { id: '1', name: 'Ada' })
    memo.delete(loadUser, '1')
    // @ts-expect-error: the id is a string
    memo.delete(loadUser, 1)
    memo.clear(loadUser)
    memo.clear()
  })
})

describe('cache types', () => {
  const store = createMemoryStore()
  const cache = createCache({ store })
  const userSchema = z.object({ id: z.string(), name: z.string() })

  it('infers the value from the schema', async () => {
    const userCache = defineCacheEntry({
      name: 'user',
      key: (id: string) => id,
      schema: userSchema,
    })
    expectTypeOf(userCache).toEqualTypeOf<
      CacheEntry<[id: string], { id: string; name: string }>
    >()
    expectTypeOf(cache.get(userCache, '1')).toEqualTypeOf<
      Promise<{ id: string; name: string } | undefined>
    >()
    expectTypeOf(
      cache.getOrSet(userCache, '1', async () => ({ id: '1', name: 'Ada' }))
    ).toEqualTypeOf<Promise<{ id: string; name: string }>>()
    await cache.set(userCache, '1', { id: '1', name: 'Ada' })
    // @ts-expect-error: not a user
    await cache.set(userCache, '1', { id: 1 })
    // @ts-expect-error: the loader returns another type
    void cache.getOrSet(userCache, '1', async () => 'Ada')
    // @ts-expect-error: the id is a string
    void cache.get(userCache, 1)
  })

  it('infers the value from the loader without schema', () => {
    const counter = defineCacheEntry({
      name: 'counter',
      key: (name: string) => name,
    })
    expectTypeOf(counter).toEqualTypeOf<CacheEntry<[name: string], Untyped>>()
    expectTypeOf(cache.getOrSet(counter, 'visits', () => 42)).toEqualTypeOf<
      Promise<number>
    >()
    expectTypeOf(cache.get(counter, 'visits')).toEqualTypeOf<Promise<unknown>>()
    void cache.set(counter, 'visits', 'anything')
  })

  it('accepts explicit types', () => {
    const typed = defineCacheEntry<[id: string], { name: string }>({
      name: 'typed',
      key: (id) => id,
    })
    expectTypeOf(
      cache.getOrSet(typed, '1', () => ({ name: 'Ada' }))
    ).toEqualTypeOf<Promise<{ name: string }>>()
    // @ts-expect-error: not the declared type
    void cache.set(typed, '1', 42)
  })
})
