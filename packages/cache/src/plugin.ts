import { declareContextKey, definePlugin } from '@dotpress/core'
import type { Cache } from './cache.js'
import { createMemo, type Memo } from './memo.js'

declare module '@dotpress/core' {
  interface RequestContext {
    /** Cache (`cachePlugin`), logging with the request logger. */
    cache: Cache
    /** Memo of the request (`cachePlugin`): a new one for each request. */
    memo: Memo
  }
}

// Accessing ctx.cache or ctx.memo without the plugin throws an explicit
// error.
declareContextKey('cache', 'cachePlugin')
declareContextKey('memo', 'cachePlugin')

/**
 * Runs each request inside a scope for its memo, like `asyncLocalMemo` of
 * `@dotpress/cache/als`.
 */
export interface MemoScope {
  run<T>(memo: Memo, next: () => Promise<T>): Promise<T>
}

/** Options of `cachePlugin()`. */
export interface CachePluginOptions {
  /** Provides `ctx.cache`. */
  cache?: Cache | undefined
  /**
   * Runs each request inside the scope of its memo, so that memoized
   * loaders work without `ctx` (`asyncLocalMemo` of `@dotpress/cache/als`).
   */
  memoScope?: MemoScope | undefined
}

/**
 * Provides `ctx.memo` (a new memo for each request) and, with a cache,
 * `ctx.cache` (logging with the request logger).
 *
 * ```ts
 * await createApp({ adapter, plugins: [cachePlugin({ cache })] })
 *
 * defineRoute({
 *   path: '/me',
 *   handler: ({ memo, cache, auth }) =>
 *     memo(loadUser, auth.userId), // or cache.getOrSet(userCache, …)
 * })
 * ```
 */
export const cachePlugin = (options: CachePluginOptions = {}) => {
  const label = 'cachePlugin()'
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (key !== 'cache' && key !== 'memoScope') {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  const { cache, memoScope } = options
  if (cache !== undefined && typeof cache?.withLogger !== 'function') {
    throw new TypeError(`${label}: cache must be created by createCache().`)
  }
  if (memoScope !== undefined && typeof memoScope?.run !== 'function') {
    throw new TypeError(
      `${label}: memoScope must have a run() method, like asyncLocalMemo.`
    )
  }

  return definePlugin({
    name: 'cache',
    setup(api) {
      api.decorateContext('memo', () => createMemo())
      api.decorateContext('cache', (ctx) => {
        if (!cache) {
          throw new Error(
            '"ctx.cache" is used, but cachePlugin() has no cache: pass cachePlugin({ cache }).'
          )
        }
        return cache.withLogger(ctx.logger)
      })
      if (memoScope) {
        api.hooks.wrapRequest((ctx, next) => memoScope.run(ctx.memo, next))
      }
    },
  })
}
