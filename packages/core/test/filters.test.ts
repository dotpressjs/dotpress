import { describe, expect, it } from 'vitest'
import { notFoundError, text } from '../src/index.js'
import { createTestApp } from './support/memory-adapter.js'

describe('response filters', () => {
  it('run app filters, then router filters, in registration order', async () => {
    const { inject } = await createTestApp(
      (router) => {
        router.addResponseFilter((_ctx, result) => ({
          ...(result as object),
          steps: [...(result as { steps: string[] }).steps, 'router-1'],
        }))
        router.addResponseFilter(async (_ctx, result) => ({
          ...(result as object),
          steps: [...(result as { steps: string[] }).steps, 'router-2'],
        }))
        router.defineRoute({
          path: '/',
          handler: () => ({ steps: ['handler'] }),
        })
      },
      {
        responseFilters: [
          (_ctx, result) => ({
            steps: [...(result as { steps: string[] }).steps, 'app'],
          }),
        ],
      }
    )

    const res = await inject({ url: '/' })

    expect(res.body).toEqual({
      steps: ['handler', 'app', 'router-1', 'router-2'],
    })
  })

  it('receive the request context', async () => {
    const { inject } = await createTestApp((router) => {
      router.addResponseFilter((ctx, result) => ({
        data: result,
        meta: { requestId: ctx.requestId },
      }))
      router.defineRoute({ path: '/', handler: () => [1, 2] })
    })

    const res = await inject({ url: '/' })

    expect(res.body).toEqual({
      data: [1, 2],
      meta: { requestId: res.headers['x-request-id'] },
    })
  })

  it('apply to the validated result only', async () => {
    const { inject } = await createTestApp((router) => {
      router.addResponseFilter((_ctx, result) => ({ wrapped: result }))
      router.defineRoute({
        path: '/',
        schema: (z) => ({ response: z.object({ id: z.string() }) }),
        handler: () => ({ id: '1', secret: 'x' }) as { id: string },
      })
    })

    expect((await inject({ url: '/' })).body).toEqual({ wrapped: { id: '1' } })
  })

  it('do not apply to errors, text or empty responses', async () => {
    const { inject } = await createTestApp((router) => {
      router.addResponseFilter(() => 'filtered')
      router.defineRoute({ path: '/error', handler: () => notFoundError() })
      router.defineRoute({ path: '/text', handler: () => text('raw') })
      router.defineRoute({ path: '/empty', handler: () => undefined })
    })

    expect((await inject({ url: '/error' })).body).toMatchObject({
      status: 404,
    })
    expect((await inject({ url: '/text' })).text).toBe('raw')
    expect((await inject({ url: '/empty' })).status).toBe(204)
  })
})
