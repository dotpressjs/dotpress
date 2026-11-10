import { describe, expect, it, vi } from 'vitest'
import {
  CacheError,
  createMemo,
  defineMemo,
  MemoBatchError,
} from '../src/index.js'

interface User {
  id: string
  name: string
}

const users: Record<string, User> = {
  '1': { id: '1', name: 'Ada' },
  '2': { id: '2', name: 'Grace' },
  '3': { id: '3', name: 'Linus' },
}

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

describe('memo with load', () => {
  it('loads a value once per memo', async () => {
    const load = vi.fn(async (id: string) => users[id])
    const loadUser = defineMemo({ name: 'user', load })
    const memo = createMemo()

    expect(await memo(loadUser, '1')).toEqual(users['1'])
    expect(await memo(loadUser, '1')).toBe(users['1'])
    expect(await memo(loadUser, '2')).toBe(users['2'])
    expect(load.mock.calls).toEqual([['1'], ['2']])

    // Another memo (another request) loads again.
    await createMemo()(loadUser, '1')
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('shares a load in progress (single flight)', async () => {
    const pending = deferred<User>()
    const load = vi.fn<(id: string) => Promise<User>>(() => pending.promise)
    const loadUser = defineMemo({ name: 'user', load })
    const memo = createMemo()

    const calls = [
      memo(loadUser, '1'),
      memo(loadUser, '1'),
      memo(loadUser, '1'),
    ]
    pending.resolve(users['1'] as User)
    expect(await Promise.all(calls)).toEqual([
      users['1'],
      users['1'],
      users['1'],
    ])
    expect(load).toHaveBeenCalledOnce()
  })

  it('shares failures in progress, but loads again after them', async () => {
    const pending = deferred<User>()
    const load = vi
      .fn<(id: string) => Promise<User>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(users['1'] as User)
    const loadUser = defineMemo({ name: 'user', load })
    const memo = createMemo()

    const calls = [memo(loadUser, '1'), memo(loadUser, '1')]
    pending.reject(new Error('database down'))
    for (const call of calls) {
      await expect(call).rejects.toThrow('database down')
    }
    expect(await memo(loadUser, '1')).toBe(users['1'])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('turns synchronous loads and throws into promises', async () => {
    const loadSync = defineMemo({
      name: 'sync',
      load: (id: string) => `#${id}`,
    })
    const failing = defineMemo({
      name: 'failing',
      load: (): string => {
        throw new Error('boom')
      },
    })
    const memo = createMemo()
    expect(await memo(loadSync, '1')).toBe('#1')
    const call = memo(failing)
    expect(call).toBeInstanceOf(Promise)
    await expect(call).rejects.toThrow('boom')
  })

  it('keys the arguments, whatever the order of object properties', async () => {
    const load = vi.fn(async (filter: object, page?: number) => ({
      filter,
      page,
    }))
    const search = defineMemo({ name: 'search', load })
    const memo = createMemo()

    await memo(search, { role: 'admin', active: true }, 1)
    await memo(search, { active: true, role: 'admin' }, 1)
    await memo(search, { active: true, role: 'admin', extra: undefined }, 1)
    expect(load).toHaveBeenCalledOnce()
    await memo(search, { active: true, role: 'admin' }, 2)
    await memo(search, { active: true, role: 'admin' })
    await memo(search, { active: false, role: 'admin' }, 1)
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('tells keys apart by type and value', async () => {
    const load = vi.fn(async (...args: unknown[]) => args)
    const any = defineMemo({ name: 'any', load })
    const memo = createMemo()
    const keys: unknown[][] = [
      [],
      [undefined],
      [null],
      ['1'],
      [1],
      [1n],
      [true],
      ['true'],
      [[1, 2]],
      [[2, 1]],
      [['1,2']],
      [{ a: 1 }],
      [{ a: '1' }],
      [{ b: 1 }],
      [new Date('2026-11-10T00:00:00.000Z')],
      [new Date('2026-11-11T00:00:00.000Z')],
      [Object.assign(Object.create(null) as object, { a: 2 })],
      ['a', 'b'],
      ['a,b'],
      [{ 'a"': 1 }],
    ]
    for (const args of keys) await memo(any, ...args)
    expect(load).toHaveBeenCalledTimes(keys.length)
    for (const args of keys) await memo(any, ...args)
    expect(load).toHaveBeenCalledTimes(keys.length)
  })

  it('uses the key option', async () => {
    const load = vi.fn(async (user: User) => user.name.length)
    const nameLength = defineMemo({
      name: 'name-length',
      load,
      key: (user) => user.id,
    })
    const memo = createMemo()
    await memo(nameLength, { id: '1', name: 'Ada' })
    expect(await memo(nameLength, { id: '1', name: 'Changed' })).toBe(3)
    expect(load).toHaveBeenCalledOnce()
  })

  it('refuses arguments that cannot be keyed', () => {
    const any = defineMemo({
      name: 'any',
      load: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 1),
    })
    const memo = createMemo()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => memo(any, () => 1)).toThrow(
      new TypeError(
        'Memo "any": cannot build a key from a function; add a key option that returns a string.'
      )
    )
    expect(() => memo(any, Symbol('s'))).toThrow(
      'Memo "any": cannot build a key from a symbol;'
    )
    expect(() => memo(any, new Map())).toThrow(
      'Memo "any": cannot build a key from an instance of Map;'
    )
    expect(() => memo(any, { nested: [new Set()] })).toThrow(
      'cannot build a key from an instance of Set;'
    )
    class Point {}
    expect(() => memo(any, new Point())).toThrow('an instance of Point;')
    expect(() =>
      memo(any, Object.create(Object.create(null) as object) as object)
    ).toThrow('cannot build a key from an instance of an unknown class;')
    expect(() => memo(any, circular)).toThrow(
      new TypeError('Memo "any": cannot build a key from a circular value.')
    )
    // The same object twice is not circular.
    const shared = { a: 1 }
    expect(() => memo(any, [shared, shared])).not.toThrow()
  })

  it('sets, deletes and clears values', async () => {
    const load = vi.fn(async (id: string) => users[id])
    const loadUser = defineMemo({ name: 'user', load })
    const loadName = defineMemo({
      name: 'name',
      load: async (id: string) => users[id]?.name,
    })
    const memo = createMemo()

    memo.set(loadUser, '1', { id: '1', name: 'Ada Lovelace' })
    expect(await memo(loadUser, '1')).toEqual({ id: '1', name: 'Ada Lovelace' })
    expect(load).not.toHaveBeenCalled()

    memo.delete(loadUser, '1')
    expect(await memo(loadUser, '1')).toBe(users['1'])
    expect(load).toHaveBeenCalledOnce()

    await memo(loadUser, '2')
    await memo(loadName, '2')
    memo.clear(loadUser)
    await memo(loadUser, '2')
    await memo(loadName, '2')
    expect(load).toHaveBeenCalledTimes(3)

    memo.clear()
    await memo(loadUser, '2')
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('keeps a value set while a load fails', async () => {
    const pending = deferred<User>()
    const loadUser = defineMemo({
      name: 'user',
      load: vi.fn<(id: string) => Promise<User>>(() => pending.promise),
    })
    const memo = createMemo()
    const call = memo(loadUser, '1')
    memo.set(loadUser, '1', users['1'] as User)
    pending.reject(new Error('down'))
    await expect(call).rejects.toThrow('down')
    expect(await memo(loadUser, '1')).toBe(users['1'])
  })
})

describe('memo with batch', () => {
  it('loads the keys of the same tick in one call, without duplicates', async () => {
    const batch = vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => users[id] ?? new Error(`No user ${id}`))
    )
    const loadUser = defineMemo({ name: 'user', batch })
    const memo = createMemo()

    const [ada, grace, again, missing] = await Promise.allSettled([
      memo(loadUser, '1'),
      memo(loadUser, '2'),
      memo(loadUser, '1'),
      memo(loadUser, '9'),
    ])
    expect(batch).toHaveBeenCalledExactlyOnceWith(['1', '2', '9'])
    expect(ada).toEqual({ status: 'fulfilled', value: users['1'] })
    expect(grace).toEqual({ status: 'fulfilled', value: users['2'] })
    expect(again).toEqual({ status: 'fulfilled', value: users['1'] })
    expect(missing).toEqual({
      status: 'rejected',
      reason: new Error('No user 9'),
    })

    // Kept for the memo; failed keys are loaded again.
    expect(await memo(loadUser, '2')).toBe(users['2'])
    await memo(loadUser, '9').catch(() => {})
    expect(batch.mock.calls).toEqual([[['1', '2', '9']], [['9']]])
  })

  it('accepts a Map, missing keys giving undefined', async () => {
    const batch = vi.fn(
      async (ids: readonly string[]) =>
        new Map(
          ids.flatMap((id) => (users[id] ? [[id, users[id]] as const] : []))
        )
    )
    const loadUser = defineMemo({ name: 'user', batch })
    const memo = createMemo()
    const found = await Promise.all([memo(loadUser, '3'), memo(loadUser, '7')])
    expect(found).toEqual([users['3'], undefined])
  })

  it('splits batches by maxBatchSize', async () => {
    const batch = vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => `#${id}`)
    )
    const label = defineMemo({ name: 'label', batch, maxBatchSize: 2 })
    const memo = createMemo()
    expect(
      await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => memo(label, id)))
    ).toEqual(['#a', '#b', '#c', '#d', '#e'])
    expect(batch.mock.calls).toEqual([[['a', 'b']], [['c', 'd']], [['e']]])
  })

  it('collects the keys requested after awaits in the same tick', async () => {
    const batch = vi.fn(async (ids: readonly string[]) => ids)
    const echo = defineMemo({ name: 'echo', batch })
    const memo = createMemo()
    const nested = async (id: string) => {
      await Promise.resolve()
      await Promise.resolve()
      return memo(echo, id)
    }
    await Promise.all([memo(echo, 'a'), nested('b'), nested('c')])
    expect(batch).toHaveBeenCalledExactlyOnceWith(['a', 'b', 'c'])
  })

  it('starts a new batch for the keys requested after a batch started', async () => {
    const batch = vi.fn(async (ids: readonly string[]) => ids)
    const echo = defineMemo({ name: 'echo', batch })
    const memo = createMemo()
    await memo(echo, 'a')
    await Promise.all([memo(echo, 'a'), memo(echo, 'b')])
    expect(batch.mock.calls).toEqual([[['a']], [['b']]])
  })

  it('fails every key when the batch fails, and loads them again later', async () => {
    const batch = vi
      .fn<(ids: readonly string[]) => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockImplementation(async (ids) => [...ids])
    const echo = defineMemo({ name: 'echo', batch })
    const memo = createMemo()
    const results = await Promise.allSettled([memo(echo, 'a'), memo(echo, 'b')])
    expect(results).toEqual([
      { status: 'rejected', reason: new Error('database down') },
      { status: 'rejected', reason: new Error('database down') },
    ])
    expect(await memo(echo, 'a')).toBe('a')
  })

  it('fails every key of a batch that throws synchronously', async () => {
    const echo = defineMemo({
      name: 'echo',
      batch: (): string[] => {
        throw new Error('boom')
      },
    })
    await expect(createMemo()(echo, 'a')).rejects.toThrow('boom')
  })

  it('reports results that do not match the keys', async () => {
    const short = defineMemo({
      name: 'short',
      batch: async (ids: readonly string[]) => ids.slice(1),
    })
    const wrong = defineMemo({
      name: 'wrong',
      batch: async () => 'nope' as unknown as string[],
    })
    const memo = createMemo()
    const error = await Promise.all([memo(short, 'a'), memo(short, 'b')]).catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(MemoBatchError)
    expect(error).toBeInstanceOf(CacheError)
    expect(error).toMatchObject({
      name: 'MemoBatchError',
      memo: 'short',
      message:
        'Memo "short": batch() returned 1 values for 2 keys: return one value per key, in the order of the keys, or a Map.',
    })
    await expect(memo(wrong, 'a')).rejects.toThrow(
      new MemoBatchError(
        'wrong',
        'batch() must return an array of values, in the order of the keys, or a Map.'
      )
    )
  })

  it('keys object keys with the key option', async () => {
    const batch = vi.fn(async (refs: readonly { id: string; at: number }[]) =>
      refs.map(({ id }) => users[id])
    )
    const loadUser = defineMemo({ name: 'user', batch, key: (ref) => ref.id })
    const memo = createMemo()
    await Promise.all([
      memo(loadUser, { id: '1', at: 1 }),
      memo(loadUser, { id: '1', at: 2 }),
    ])
    expect(batch).toHaveBeenCalledExactlyOnceWith([{ id: '1', at: 1 }])
  })

  it('uses the schedule option', async () => {
    const runs: (() => void)[] = []
    const batch = vi.fn(async (ids: readonly string[]) => ids)
    const echo = defineMemo({
      name: 'echo',
      batch,
      schedule: (run) => void runs.push(run),
    })
    const memo = createMemo()
    const calls = [memo(echo, 'a'), memo(echo, 'b')]
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(batch).not.toHaveBeenCalled()
    expect(runs).toHaveLength(1)
    runs[0]?.()
    expect(await Promise.all(calls)).toEqual(['a', 'b'])
  })

  it('sets and deletes values of a batch memo', async () => {
    const batch = vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => users[id])
    )
    const loadUser = defineMemo({ name: 'user', batch })
    const memo = createMemo()
    memo.set(loadUser, '1', users['3'])
    expect(await memo(loadUser, '1')).toBe(users['3'])
    memo.delete(loadUser, '1')
    expect(await memo(loadUser, '1')).toBe(users['1'])
    expect(batch).toHaveBeenCalledExactlyOnceWith(['1'])
  })
})

describe('defineMemo()', () => {
  it('returns a frozen definition with its name', () => {
    const loadUser = defineMemo({ name: 'user', load: async () => 1 })
    expect(loadUser).toEqual({ name: 'user' })
    expect(Object.isFrozen(loadUser)).toBe(true)
  })

  it('checks its options', () => {
    const define = (options: unknown) => () => defineMemo(options as never)
    expect(define(null)).toThrow('defineMemo(): expected an object of options.')
    expect(define('user')).toThrow(
      'defineMemo(): expected an object of options.'
    )
    for (const name of [undefined, '', '-user', 'a b', 'x'.repeat(129), 42]) {
      expect(define({ name, load: () => 1 })).toThrow(
        'defineMemo(): name must have 1 to 128 letters, digits, ".", "_", ":" or "-", starting with a letter or a digit.'
      )
    }
    expect(define({ name: 'a'.repeat(128), load: () => 1 })).not.toThrow()
    expect(define({ name: 'user.v2:by-id_1', load: () => 1 })).not.toThrow()
    expect(define({ name: 'user' })).toThrow(
      'defineMemo("user"): load or batch must be a function.'
    )
    expect(define({ name: 'user', load: 'x' })).toThrow(
      'defineMemo("user"): load or batch must be a function.'
    )
    expect(define({ name: 'user', batch: 'x' })).toThrow(
      'defineMemo("user"): batch must be a function.'
    )
    expect(define({ name: 'user', load: () => 1, batch: () => [] })).toThrow(
      'defineMemo("user"): set load or batch, not both.'
    )
    expect(define({ name: 'user', load: () => 1, maxBatchSize: 2 })).toThrow(
      'defineMemo("user"): unknown option "maxBatchSize".'
    )
    expect(define({ name: 'user', batch: () => [], ttl: 1 })).toThrow(
      'defineMemo("user"): unknown option "ttl".'
    )
    expect(define({ name: 'user', load: () => 1, key: 'id' })).toThrow(
      'defineMemo("user"): key must be a function.'
    )
    for (const maxBatchSize of [0, 1.5, '10', -Infinity]) {
      expect(define({ name: 'user', batch: () => [], maxBatchSize })).toThrow(
        'defineMemo("user"): maxBatchSize must be a positive integer.'
      )
    }
    expect(
      define({ name: 'user', batch: () => [], maxBatchSize: Infinity })
    ).not.toThrow()
    expect(define({ name: 'user', batch: () => [], schedule: 1 })).toThrow(
      'defineMemo("user"): schedule must be a function.'
    )
  })
})

describe('createMemo()', () => {
  it('refuses definitions it did not create', () => {
    const memo = createMemo()
    const fake = { name: 'user' } as never
    expect(() => memo(fake)).toThrow(
      new TypeError('memo(): expected a memo created by defineMemo().')
    )
    expect(() => memo(null as never)).toThrow('memo(): expected a memo')
    expect(() => memo.set(fake, 1 as never)).toThrow(
      'memo.set(): expected a memo created by defineMemo().'
    )
    expect(() => memo.delete(fake)).toThrow(
      'memo.delete(): expected a memo created by defineMemo().'
    )
    expect(() => memo.clear(fake)).toThrow(
      'memo.clear(): expected a memo created by defineMemo().'
    )
    expect(Object.isFrozen(memo)).toBe(true)
  })
})
