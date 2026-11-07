import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { createApp, createRouter } from '../src/index.js'
import { createTestApp, memoryAdapter } from './support/memory-adapter.js'

describe('request validation', () => {
  it('returns a 400 error with a flat list of issues from every source', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/users/:id',
        schema: (z) => ({
          params: z.object({ id: z.uuid() }),
          query: z.object({ sort: z.enum(['asc', 'desc']) }),
          body: z.object({ name: z.string(), age: z.number().min(13) }),
        }),
        handler: () => ({ ok: true }),
      })
    })

    const res = await inject({
      method: 'post',
      url: '/users/not-a-uuid?sort=up',
      body: { age: 10 },
    })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      status: 400,
      error: 'VALIDATION_FAILED',
      message: 'Validation failed',
      data: {
        issues: [
          {
            source: 'params',
            path: ['id'],
            code: 'invalid_format',
            message: expect.any(String),
          },
          {
            source: 'query',
            path: ['sort'],
            code: 'invalid_value',
            message: expect.any(String),
          },
          {
            source: 'body',
            path: ['name'],
            code: 'invalid_type',
            message: expect.any(String),
          },
          {
            source: 'body',
            path: ['age'],
            code: 'too_small',
            message: expect.any(String),
          },
        ],
      },
    })
  })

  it('gives handlers the parsed values', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/search',
        schema: (z) => ({
          query: z.object({
            page: z.coerce.number().int(),
            tags: z.array(z.string()).default([]),
          }),
          body: z.object({ term: z.string().trim() }),
        }),
        handler: ({ req }) => ({ query: req.query, body: req.body }),
      })
    })

    const res = await inject({
      method: 'post',
      url: '/search?page=2&ignored=1',
      body: { term: '  dotpress  ', extra: true },
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      query: { page: 2, tags: [] },
      body: { term: 'dotpress' },
    })
  })

  it('supports async refinements', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/accounts',
        schema: (z) => ({
          body: z.object({
            email: z
              .email()
              .refine(async (email) => email !== 'taken@example.com', {
                message: 'Email already used',
              }),
          }),
        }),
        handler: () => ({ ok: true }),
      })
    })

    const taken = await inject({
      method: 'post',
      url: '/accounts',
      body: { email: 'taken@example.com' },
    })
    const free = await inject({
      method: 'post',
      url: '/accounts',
      body: { email: 'free@example.com' },
    })

    expect(taken.status).toBe(400)
    expect(taken.body).toMatchObject({
      data: { issues: [{ source: 'body', message: 'Email already used' }] },
    })
    expect(free.status).toBe(200)
  })

  it('accepts schemas declared as a plain object', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/items',
        schema: { body: z.object({ name: z.string() }) },
        handler: ({ req }) => req.body,
      })
    })

    expect(
      (await inject({ method: 'post', url: '/items', body: {} })).status
    ).toBe(400)
    expect(
      (await inject({ method: 'post', url: '/items', body: { name: 'a' } }))
        .body
    ).toEqual({ name: 'a' })
  })

  it('rejects non-Zod schemas when the app is created', async () => {
    const router = createRouter()
    router.defineRoute({
      path: '/invalid',
      // @ts-expect-error not a Zod schema
      schema: { body: { type: 'object' } },
      handler: () => null,
    })

    await expect(
      createApp({ adapter: memoryAdapter(), routers: [router] })
    ).rejects.toThrow('expected a Zod 4 schema')
  })
})
