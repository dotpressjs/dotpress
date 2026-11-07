/**
 * Type-level tests, checked by `tsc -p tsconfig.test.json`.
 */
import { describe, expectTypeOf, it } from 'vitest'
import {
  createRouter,
  json,
  notFoundError,
  redirect,
  type EmptyObject,
  type PathParams,
  type QueryValues,
} from '../src/index.js'

const router = createRouter()

describe('type inference', () => {
  it('infers path parameters from the path', () => {
    expectTypeOf<PathParams<'/orgs/:orgId/members/:id'>>().toEqualTypeOf<{
      orgId: string
      id: string
    }>()
    expectTypeOf<PathParams<'/health'>>().toEqualTypeOf<EmptyObject>()
    expectTypeOf<PathParams<string>>().toEqualTypeOf<Record<string, string>>()

    router.defineRoute({
      path: '/orgs/:orgId/members/:id',
      handler: ({ req }) => {
        expectTypeOf(req.params).toEqualTypeOf<{ orgId: string; id: string }>()
        expectTypeOf(req.query).toEqualTypeOf<QueryValues>()
        expectTypeOf(req.body).toBeUnknown()
      },
    })
  })

  it('merges group parameters', () => {
    router
      .createGroup('/orgs/:orgId')
      .createGroup('/projects/:projectId')
      .defineRoute({
        path: '/tasks/:taskId',
        handler: ({ req }) => {
          expectTypeOf(req.params).toEqualTypeOf<{
            orgId: string
            projectId: string
            taskId: string
          }>()
        },
      })
  })

  it('types the request from the schema', () => {
    router.defineRoute({
      method: 'post',
      path: '/members/:id',
      schema: (z) => ({
        params: z.object({ id: z.coerce.number() }),
        query: z.object({ notify: z.stringbool().optional() }),
        body: z.object({ name: z.string(), age: z.number().optional() }),
      }),
      handler: ({ req }) => {
        expectTypeOf(req.params).toEqualTypeOf<{ id: number }>()
        expectTypeOf(req.query).toEqualTypeOf<{
          notify?: boolean | undefined
        }>()
        expectTypeOf(req.body).toEqualTypeOf<{
          name: string
          age?: number | undefined
        }>()
      },
    })
  })

  it('checks the handler result against the response schema', () => {
    router.defineRoute({
      path: '/ok',
      schema: (z) => ({ response: z.object({ id: z.string() }) }),
      handler: async () => {
        if (Math.random() > 0.5) return notFoundError()
        if (Math.random() > 0.5) return redirect('/elsewhere')
        if (Math.random() > 0.5) return json({ id: '1' }, { status: 201 })
        return { id: '1' }
      },
    })

    router.defineRoute({
      path: '/wrong',
      schema: (z) => ({ response: z.object({ id: z.string() }) }),
      // @ts-expect-error id must be a string
      handler: () => ({ id: 1 }),
    })

    router.defineRoute({
      path: '/wrong-json',
      schema: (z) => ({ response: z.object({ id: z.string() }) }),
      // @ts-expect-error json() data must match the schema
      handler: () => json({ id: 1 }),
    })

    router.defineRoute({
      method: 'delete',
      path: '/never',
      schema: (z) => ({ response: z.never() }),
      // @ts-expect-error nothing may be returned
      handler: () => ({ deleted: true }),
    })
  })

  it('exposes context augmentations', () => {
    router.defineRoute({
      path: '/me',
      handler: (ctx) => {
        expectTypeOf(ctx.tenantId).toEqualTypeOf<string | undefined>()
        expectTypeOf(ctx.requestId).toBeString()
      },
    })
  })
})

declare module '../src/index.js' {
  interface RequestContext {
    tenantId?: string
  }
}
