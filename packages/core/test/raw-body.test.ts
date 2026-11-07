import { describe, expect, it } from 'vitest'
import { createRouter, type Middleware } from '../src/index.js'
import { createTestApp, silentLogger } from './support/memory-adapter.js'

const decode = (bytes: Uint8Array | undefined) =>
  bytes && new TextDecoder().decode(bytes)

describe('rawBody', () => {
  it('exposes the raw bytes in addition to the parsed body', async () => {
    const payload = '{ "type" :  "invoice.paid" }'
    const seen: (string | undefined)[] = []
    const verifySignature: Middleware = ({ req }) => {
      seen.push(decode(req.rawBody))
    }

    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/webhooks',
        rawBody: true,
        middlewares: [verifySignature],
        schema: (z) => ({ body: z.object({ type: z.string() }) }),
        handler: ({ req }) => ({
          raw: decode(req.rawBody),
          type: req.body.type,
        }),
      })
    })

    const res = await inject({
      method: 'post',
      url: '/webhooks',
      rawBody: payload,
    })

    expect(res.body).toEqual({ raw: payload, type: 'invoice.paid' })
    expect(seen).toEqual([payload])
  })

  it('gives empty bytes when the request has no body', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/ping',
        rawBody: true,
        handler: ({ req }) => ({ length: req.rawBody.byteLength }),
      })
    })

    expect((await inject({ method: 'post', url: '/ping' })).body).toEqual({
      length: 0,
    })
  })

  it('is not exposed on other routes', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/regular',
        handler: ({ req }) => ({ hasRaw: req.rawBody !== undefined }),
      })
    })

    const res = await inject({
      method: 'post',
      url: '/regular',
      rawBody: '{"a":1}',
    })

    expect(res.body).toEqual({ hasRaw: false })
  })

  it('fails when the adapter cannot provide the raw bytes', async () => {
    const logger = silentLogger()
    const { inject } = await createTestApp(
      (router) => {
        router.defineRoute({
          method: 'post',
          path: '/webhooks',
          rawBody: true,
          handler: () => ({ unreachable: true }),
        })
      },
      { logger, exposeErrors: true }
    )

    // A parsed body without raw bytes, as after a native body parser.
    const res = await inject({ method: 'post', url: '/webhooks', body: {} })

    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({
      data: { message: expect.stringContaining('raw request body') },
    })
  })

  it('is exposed in the route introspection data', async () => {
    const { app } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/webhooks',
        rawBody: true,
        handler: () => null,
      })
      router.defineRoute({ path: '/other', handler: () => null })
    })

    expect(app.routes.map((route) => route.rawBody)).toEqual([true, false])
  })

  it('rejects invalid values', () => {
    expect(() =>
      createRouter().defineRoute({
        path: '/invalid',
        // @ts-expect-error rawBody is a boolean
        rawBody: 'yes',
        handler: () => null,
      })
    ).toThrow('Invalid rawBody option')
  })
})
