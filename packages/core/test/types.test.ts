/**
 * Type-level tests, checked by `tsc -p tsconfig.test.json`.
 */
import { describe, expectTypeOf, it } from 'vitest'
import {
  createRouter,
  defineMiddleware,
  definePlugin,
  forbiddenError,
  unauthorizedError,
  json,
  notFoundError,
  redirect,
  type EmptyObject,
  type PathParams,
  type QueryValues,
  type UploadedFiles,
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

  it('types the raw body from the rawBody option', () => {
    router.defineRoute({
      method: 'post',
      path: '/webhooks/stripe',
      rawBody: true,
      schema: (z) => ({ body: z.object({ type: z.string() }) }),
      handler: ({ req }) => {
        expectTypeOf(req.rawBody).toEqualTypeOf<Uint8Array>()
        expectTypeOf(req.body).toEqualTypeOf<{ type: string }>()
      },
    })

    router.defineRoute({
      method: 'post',
      path: '/regular',
      handler: ({ req }) => {
        expectTypeOf(req.rawBody).toEqualTypeOf<Uint8Array | undefined>()
      },
    })
  })

  it('types uploaded files from the schema', () => {
    router.defineRoute({
      method: 'post',
      path: '/avatar',
      schema: (z) => ({ files: z.object({ avatar: z.file() }) }),
      handler: ({ req }) => {
        expectTypeOf(req.files).toEqualTypeOf<{ avatar: File }>()
      },
    })

    router.defineRoute({
      method: 'post',
      path: '/untyped',
      handler: ({ req }) => {
        expectTypeOf(req.files).toEqualTypeOf<UploadedFiles>()
      },
    })
  })

  it('types the context properties guaranteed by middlewares', () => {
    const requireAccount = defineMiddleware<{ account: { id: string } }>(
      (ctx) => (ctx.account ? undefined : unauthorizedError())
    )
    const requireOrg = defineMiddleware<{ org: { slug: string } }>((ctx) =>
      ctx.org ? undefined : forbiddenError()
    )

    router.defineRoute({
      path: '/route',
      middlewares: [requireAccount, (ctx) => void ctx.requestId, requireOrg],
      handler: (ctx) => {
        expectTypeOf(ctx.account).toEqualTypeOf<{ id: string }>()
        expectTypeOf(ctx.org).toEqualTypeOf<{ slug: string }>()
      },
    })

    const accounts = router.createGroup('/accounts', [requireAccount])
    accounts.defineRoute({
      path: '/me',
      handler: (ctx) => {
        expectTypeOf(ctx.account).toEqualTypeOf<{ id: string }>()
        expectTypeOf(ctx.org).toEqualTypeOf<{ slug: string } | undefined>()
      },
    })
    accounts.createGroup('/:accountId/orgs', [requireOrg]).defineRoute({
      path: '/current',
      handler: (ctx) => {
        expectTypeOf(ctx.account).toEqualTypeOf<{ id: string }>()
        expectTypeOf(ctx.org).toEqualTypeOf<{ slug: string }>()
        expectTypeOf(ctx.req.params).toEqualTypeOf<{ accountId: string }>()
      },
    })

    router.defineRoute({
      path: '/inline',
      middlewares: [(ctx) => void ctx.requestId],
      schema: (z) => ({ query: z.object({ page: z.coerce.number() }) }),
      handler: (ctx) => {
        expectTypeOf(ctx.account).toEqualTypeOf<{ id: string } | undefined>()
        expectTypeOf(ctx.req.query.page).toEqualTypeOf<number>()
      },
    })
  })

  it('types decorated context keys', () => {
    definePlugin({
      name: 'tenant',
      setup(api) {
        api.decorateContext('tenantId', (ctx) => ctx.req.header('x-tenant'))
        // @ts-expect-error the factory must return the declared type
        api.decorateContext('tenantId', () => 42)
        // @ts-expect-error unknown context key
        api.decorateContext('unknownKey', () => null)
      },
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
    account?: { id: string }
    org?: { slug: string }
  }
}
