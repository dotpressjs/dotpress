import { describe, expect, it, vi } from 'vitest'
import {
  createApp,
  createConsoleLogger,
  createRouter,
  type Router,
} from '../src/index.js'
import {
  createTestApp,
  memoryAdapter,
  silentLogger,
} from './support/memory-adapter.js'

describe('unknown options', () => {
  it('are rejected by createApp()', async () => {
    await expect(
      createApp({
        adapter: memoryAdapter(),
        routers: [],
        logger: silentLogger(),
        exposeError: true,
      } as never)
    ).rejects.toThrow(
      new TypeError('createApp(): unknown option "exposeError".')
    )
  })

  it('are rejected in route definitions', () => {
    const router = createRouter()
    const handler = () => null

    expect(() =>
      router.defineRoute({ path: '/a', middleware: [], handler } as never)
    ).toThrow(new TypeError('Route "/a": unknown option "middleware".'))
    expect(() =>
      router.defineRoute({
        path: '/b',
        meta: { summery: 'Typo' },
        handler,
      } as never)
    ).toThrow(new TypeError('Route "/b": unknown option "meta.summery".'))
    expect(() =>
      router.defineRoute({
        path: '/c',
        meta: { responses: { 404: { description: 'x', content: 'y' } } },
        handler,
      } as never)
    ).toThrow(
      new TypeError('Route "/c": unknown option "meta.responses.404.content".')
    )
    // In a group, the label has the full path.
    expect(() =>
      router
        .createGroup('/users')
        .defineRoute({ path: '/:id', handlr: handler } as never)
    ).toThrow(new TypeError('Route "/users/:id": unknown option "handlr".'))
  })

  it('are rejected in route schemas, when the app is created', async () => {
    await expect(
      createTestApp((router) => {
        router.defineRoute({
          path: '/search',
          schema: (z: typeof import('zod')) => ({
            qurey: z.object({ q: z.string() }),
          }),
          handler: () => null,
        } as never)
      })
    ).rejects.toThrow(
      new TypeError('Route "/search": unknown option "schema.qurey".')
    )
  })

  it('are rejected by createConsoleLogger(), with invalid levels', () => {
    expect(() => createConsoleLogger({ levl: 'debug' } as never)).toThrow(
      new TypeError('createConsoleLogger(): unknown option "levl".')
    )
    expect(() => createConsoleLogger({ level: 'trace' as never })).toThrow(
      new TypeError(
        'createConsoleLogger(): level must be one of debug, info, warn, error.'
      )
    )
  })
})

describe('createApp()', () => {
  it('only mounts routers made by createRouter()', async () => {
    const router = { ...createRouter() } as Router

    await expect(
      createApp({
        adapter: memoryAdapter(),
        routers: [router],
        logger: silentLogger(),
      })
    ).rejects.toThrow(
      new TypeError(
        'createApp(): every router must be created with createRouter().'
      )
    )
  })

  it('warns when several copies of @dotpress/core are loaded', async () => {
    const copies = (globalThis as Record<symbol, Set<string>>)[
      Symbol.for('dotpress.core.copies')
    ]
    expect([...copies]).toHaveLength(1)

    const other = 'file:///app/node_modules/@dotpress/core/dist/index.js'
    copies.add(other)
    try {
      const logger = silentLogger()
      const warn = vi.spyOn(logger, 'warn')
      await createApp({ adapter: memoryAdapter(), routers: [], logger })

      expect(warn).toHaveBeenCalledWith(
        { copies: [expect.any(String), other] },
        expect.stringMatching(/^Several copies of @dotpress\/core are loaded/)
      )
    } finally {
      copies.delete(other)
    }

    const logger = silentLogger()
    await createApp({ adapter: memoryAdapter(), routers: [], logger })
    expect(logger.entries).toEqual([])
  })
})
