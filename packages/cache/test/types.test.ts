import { describe, expectTypeOf, it } from 'vitest'
import { createMemo, defineMemo, type MemoDefinition } from '../src/index.js'

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
