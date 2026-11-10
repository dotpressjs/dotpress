import { describe, expect, it, vi } from 'vitest'
import {
  asyncLocalMemo,
  currentMemo,
  memoized,
  runWithMemo,
} from '../src/als.js'
import { createMemo, defineMemo } from '../src/index.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe('runWithMemo()', () => {
  it('shares a memo during the run, awaits included', async () => {
    const load = vi.fn(async (id: string) => ({ id }))
    const getUser = memoized(defineMemo({ name: 'user', load }))
    const result = await runWithMemo(async () => {
      const first = await getUser('1')
      await tick()
      const second = await getUser('1')
      return first === second
    })
    expect(result).toBe(true)
    expect(load).toHaveBeenCalledOnce()
  })

  it('isolates parallel runs', async () => {
    const load = vi.fn(async (id: string) => ({ id }))
    const getUser = memoized(defineMemo({ name: 'user', load }))
    await Promise.all([
      runWithMemo(() => getUser('1')),
      runWithMemo(() => getUser('1')),
    ])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('uses the memo it is given, and returns the result of the function', () => {
    const memo = createMemo()
    expect(runWithMemo(() => currentMemo(), memo)).toBe(memo)
    expect(runWithMemo(() => 42)).toBe(42)
  })

  it('nests scopes', () => {
    runWithMemo(() => {
      const outer = currentMemo()
      runWithMemo(() => {
        expect(currentMemo()).not.toBe(outer)
      })
      expect(currentMemo()).toBe(outer)
    })
  })

  it('refuses what is not a function', () => {
    expect(() => runWithMemo('run' as never)).toThrow(
      new TypeError('runWithMemo(): expected a function.')
    )
  })
})

describe('currentMemo() and memoized()', () => {
  it('fail outside a scope', async () => {
    const message =
      'No memo scope: run the code with runWithMemo(), or install cachePlugin({ memoScope: asyncLocalMemo }).'
    expect(() => currentMemo()).toThrow(new Error(message))
    const getUser = memoized(
      defineMemo({ name: 'user', load: async (id: string) => id })
    )
    expect(() => getUser('1')).toThrow(message)
  })

  it('set and delete values through the current memo', async () => {
    const load = vi.fn(async (id: string) => ({ id, name: 'Ada' }))
    const loadUser = defineMemo({ name: 'user', load })
    await runWithMemo(async () => {
      currentMemo().set(loadUser, '1', { id: '1', name: 'Grace' })
      expect(await memoized(loadUser)('1')).toEqual({ id: '1', name: 'Grace' })
    })
    expect(load).not.toHaveBeenCalled()
  })
})

describe('asyncLocalMemo', () => {
  it('runs a function with the memo as the current one', async () => {
    const memo = createMemo()
    expect(
      await asyncLocalMemo.run(memo, async () => {
        await tick()
        return currentMemo()
      })
    ).toBe(memo)
    expect(Object.isFrozen(asyncLocalMemo)).toBe(true)
  })
})
