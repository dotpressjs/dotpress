// AsyncLocalStorage: Node.js, Bun, Deno, and Cloudflare Workers with the
// nodejs_compat (or nodejs_als) compatibility flag.
/// <reference types="node" />
import { AsyncLocalStorage } from 'node:async_hooks'
import { createMemo, type Memo, type MemoDefinition } from './memo.js'
import type { MemoScope } from './plugin.js'

const storage = new AsyncLocalStorage<Memo>()

/**
 * Runs a function inside the scope of a memo (a new one by default): the
 * memoized loaders called during its run, awaits included, share it.
 *
 * ```ts
 * // A listener, a job, a script
 * await runWithMemo(() => sendInvoices(customerId))
 * ```
 */
export const runWithMemo = <T>(fn: () => T, memo: Memo = createMemo()): T => {
  if (typeof fn !== 'function') {
    throw new TypeError('runWithMemo(): expected a function.')
  }
  return storage.run(memo, fn)
}

/** The memo of the current scope; throws outside a scope. */
export const currentMemo = (): Memo => {
  const memo = storage.getStore()
  if (!memo) {
    throw new Error(
      'No memo scope: run the code with runWithMemo(), or install cachePlugin({ memoScope: asyncLocalMemo }).'
    )
  }
  return memo
}

/**
 * A function that loads through the memo of the current scope, without
 * passing a context around.
 *
 * ```ts
 * export const getUser = memoized(loadUser)
 * // anywhere during a request or a runWithMemo() call
 * const user = await getUser(id)
 * ```
 */
export const memoized = <A extends readonly unknown[], T>(
  definition: MemoDefinition<A, T>
): ((...args: A) => Promise<T>) => {
  return (...args: A) => currentMemo()(definition, ...args)
}

/**
 * Scope of `cachePlugin({ memoScope: asyncLocalMemo })`: each request runs
 * with `ctx.memo` as the memo of the scope.
 */
export const asyncLocalMemo: MemoScope = Object.freeze({
  run: <T>(memo: Memo, next: () => Promise<T>) => storage.run(memo, next),
})
