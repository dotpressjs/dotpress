import { createRouter, definePlugin } from '@dotpress/core'
import { describe, expect, it } from 'vitest'
import { createTestApp, memoryAdapter } from '../src/index.js'

const routerWith = (
  define: (router: ReturnType<typeof createRouter>) => void
) => {
  const router = createRouter()
  define(router)
  return router
}

describe('createTestApp()', () => {
  it('sends requests to the app without opening a port', async () => {
    const { fetch, logger } = await createTestApp({
      routers: [
        routerWith((router) => {
          router.defineRoute({
            method: 'post',
            path: '/echo/:id',
            handler: ({ req }) => ({ id: req.params.id, body: req.body }),
          })
          router.defineRoute({
            path: '/crash',
            handler: () => {
              throw new Error('Boom')
            },
          })
        }),
      ],
    })

    const res = await fetch('/echo/1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: '1', body: { a: 1 } })

    expect((await fetch('/crash')).status).toBe(500)
    expect(logger.entries).toContainEqual({
      level: 'error',
      args: [
        expect.objectContaining({ message: 'Boom' }),
        'Unhandled error while processing request',
      ],
    })
  })

  it('installs plugins', async () => {
    const { fetch } = await createTestApp({
      routers: [],
      plugins: [
        definePlugin({
          name: 'health',
          setup(api) {
            api.addRoute({ path: '/health', handler: () => ({ ok: true }) })
          },
        }),
      ],
    })

    expect(await (await fetch('/health')).json()).toEqual({ ok: true })
  })

  it('applies the adapter options', async () => {
    const { fetch } = await createTestApp({
      adapter: { ip: '203.0.113.7', bodyLimit: 4 },
      routers: [
        routerWith((router) => {
          router.defineRoute({
            method: 'post',
            path: '/ip',
            handler: ({ req }) => ({ ip: req.ip }),
          })
        }),
      ],
    })

    expect(await (await fetch('/ip', { method: 'POST' })).json()).toEqual({
      ip: '203.0.113.7',
    })
    expect((await fetch('/ip', { method: 'POST', body: '12345' })).status).toBe(
      413
    )
  })
})

describe('memoryAdapter()', () => {
  it('must be mounted before handling requests', async () => {
    await expect(
      memoryAdapter().fetch(new Request('http://localhost/'))
    ).rejects.toThrow('not mounted')
  })
})
