import { createRouter, type Logger, type Middleware } from '@dotpress/core'
import { createTestApp } from '@dotpress/testing'
import { describe, expect, it, vi } from 'vitest'
import { asyncLocalMemo, memoized } from '../src/als.js'
import {
  createCache,
  createMemoryStore,
  defineCacheEntry,
  defineMemo,
} from '../src/index.js'
import { cachePlugin } from '../src/plugin.js'

/** A logger recording its entries with the bindings of its children. */
const createBoundLogger = () => {
  type Level = 'debug' | 'info' | 'warn' | 'error'
  const entries: { level: Level; bindings: object; args: unknown[] }[] = []
  const create = (bindings: object): Logger => {
    const log =
      (level: Level) =>
      (...args: unknown[]) =>
        void entries.push({ level, bindings, args })
    return {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      child: (more) => create({ ...bindings, ...more }),
    }
  }
  return Object.assign(create({}), { entries })
}

describe('cachePlugin()', () => {
  it('provides a new memo for each request, shared by its middlewares and handler', async () => {
    const load = vi.fn(async (id: string) => ({ id, name: 'Ada' }))
    const loadUser = defineMemo({ name: 'user', load })
    const authenticate: Middleware = async (ctx) => {
      await ctx.memo(loadUser, '42')
    }
    const router = createRouter()
    router.defineRoute({
      path: '/me',
      middlewares: [authenticate],
      handler: async ({ memo }) => memo(loadUser, '42'),
    })
    const { fetch, close } = await createTestApp({
      routers: [router],
      plugins: [cachePlugin()],
    })
    expect(await (await fetch('/me')).json()).toEqual({ id: '42', name: 'Ada' })
    expect(load).toHaveBeenCalledOnce()
    await fetch('/me')
    expect(load).toHaveBeenCalledTimes(2)
    await close()
  })

  it('provides the cache, logging with the request logger', async () => {
    const counter = defineCacheEntry({ name: 'counter' })
    const cache = createCache({ store: createMemoryStore() })
    const router = createRouter()
    router.defineRoute({
      path: '/count',
      handler: async ({ cache: scoped }) => ({
        value: await scoped.getOrSet(counter, () => 1),
      }),
    })
    const logger = createBoundLogger()
    const { fetch, close } = await createTestApp({
      routers: [router],
      plugins: [cachePlugin({ cache })],
      logger,
    })
    const res = await fetch('/count')
    expect(await res.json()).toEqual({ value: 1 })
    expect(logger.entries).toContainEqual({
      level: 'debug',
      bindings: { requestId: res.headers.get('x-request-id') },
      args: [{ entry: 'counter', key: 'counter:v1' }, 'Cache miss'],
    })
    await close()
  })

  it('fails clearly when ctx.cache is used without a cache', async () => {
    const router = createRouter()
    router.defineRoute({ path: '/count', handler: ({ cache }) => cache })
    const { fetch, logger, close } = await createTestApp({
      routers: [router],
      plugins: [cachePlugin()],
    })
    expect((await fetch('/count')).status).toBe(500)
    const [error] = logger.entries.find(({ level }) => level === 'error')
      ?.args as [Error]
    expect(error.message).toBe(
      '"ctx.cache" is used, but cachePlugin() has no cache: pass cachePlugin({ cache }).'
    )
    await close()
  })

  it('fails clearly when the plugin is not installed', async () => {
    const router = createRouter()
    router.defineRoute({ path: '/me', handler: ({ memo }) => memo })
    const { fetch, logger, close } = await createTestApp({ routers: [router] })
    expect((await fetch('/me')).status).toBe(500)
    const [error] = logger.entries.find(({ level }) => level === 'error')
      ?.args as [Error]
    expect(error.message).toContain('cachePlugin')
    await close()
  })

  it('runs each request in the scope of its memo with memoScope', async () => {
    const load = vi.fn(async (id: string) => ({ id }))
    const loadUser = defineMemo({ name: 'user', load })
    const getUser = memoized(loadUser)
    // A service that does not receive ctx.
    const describeUser = async (id: string) => `user ${(await getUser(id)).id}`
    const router = createRouter()
    router.defineRoute({
      path: '/me',
      handler: async ({ memo }) => {
        const user = await memo(loadUser, '42')
        return { user, text: await describeUser('42') }
      },
    })
    const { fetch, close } = await createTestApp({
      routers: [router],
      plugins: [cachePlugin({ memoScope: asyncLocalMemo })],
    })
    const results = await Promise.all([fetch('/me'), fetch('/me')])
    for (const res of results) {
      expect(await res.json()).toEqual({ user: { id: '42' }, text: 'user 42' })
    }
    expect(load).toHaveBeenCalledTimes(2) // once per request
    await close()
  })

  it('checks its options', () => {
    expect(() => cachePlugin(null as never)).toThrow(
      'cachePlugin(): expected an object of options.'
    )
    expect(() => cachePlugin('cache' as never)).toThrow(
      'cachePlugin(): expected an object of options.'
    )
    expect(() => cachePlugin({ store: {} } as never)).toThrow(
      'cachePlugin(): unknown option "store".'
    )
    for (const cache of [null, {}, createMemoryStore()]) {
      expect(() => cachePlugin({ cache } as never)).toThrow(
        'cachePlugin(): cache must be created by createCache().'
      )
    }
    for (const memoScope of [null, {}, () => {}]) {
      expect(() => cachePlugin({ memoScope } as never)).toThrow(
        'cachePlugin(): memoScope must have a run() method, like asyncLocalMemo.'
      )
    }
    expect(cachePlugin().name).toBe('cache')
  })
})
