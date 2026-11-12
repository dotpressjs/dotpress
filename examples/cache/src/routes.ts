import {
  createRouter,
  defineMiddleware,
  forbiddenError,
  notFoundError,
  unauthorizedError,
  type RequestContext,
} from '@dotpress/core'
import type { Database } from './db.ts'
import {
  articleCache,
  articleListCache,
  ArticleView,
  toView,
  type UserMemo,
} from './loaders.ts'

/**
 * The current user, from the `x-user-id` header: a stand-in for real
 * authentication (see the auth example). Memoized: the middleware and the
 * handler share one query.
 */
const viewerOf = (ctx: RequestContext, users: UserMemo) => {
  const id = ctx.req.header('x-user-id')
  return id ? ctx.memo(users, id) : undefined
}

export const articlesRouter = (db: Database, users: UserMemo) => {
  const router = createRouter()

  const requireViewer = defineMiddleware(async (ctx) =>
    (await viewerOf(ctx, users)) ? undefined : unauthorizedError()
  )

  router.defineRoute({
    path: '/articles',
    schema: (z) => ({ response: z.array(ArticleView) }),
    meta: { summary: 'List the articles', tags: ['articles'] },
    handler: ({ cache, memo }) =>
      cache.getOrSet(articleListCache, async () => {
        const articles = await db.articles.list()
        // One query for every author, not one per article: the memo
        // batches the ids requested together.
        return Promise.all(
          articles.map((article) => toView(memo, users, article))
        )
      }),
  })

  router.defineRoute({
    path: '/articles/:id',
    schema: () => ({ response: ArticleView }),
    meta: {
      summary: 'Get an article',
      tags: ['articles'],
      responses: { 404: 'Article not found' },
    },
    handler: async ({ req, cache, memo }) => {
      const { id } = req.params
      // `undefined` (unknown article) is not cached.
      const view = await cache.getOrSet(articleCache, id, async () => {
        const article = await db.articles.findById(id)
        return article && toView(memo, users, article)
      })
      return view ?? notFoundError('Article not found')
    },
  })

  router.defineRoute({
    method: 'patch',
    path: '/articles/:id',
    middlewares: [requireViewer],
    schema: (z) => ({
      body: z.object({ title: z.string().trim().min(1).max(200) }),
      response: ArticleView,
    }),
    meta: {
      summary: 'Rename an article (its author only)',
      tags: ['articles'],
      responses: { 403: 'Not the author', 404: 'Article not found' },
    },
    handler: async (ctx) => {
      const { req, cache, memo } = ctx
      const { id } = req.params
      const article = await db.articles.findById(id)
      if (!article) return notFoundError('Article not found')
      // Loaded by the middleware: no new query.
      const viewer = await viewerOf(ctx, users)
      if (article.authorId !== viewer?.id) return forbiddenError()

      const updated = await db.articles.update(id, req.body.title)
      // This article, and the list that shows its title.
      await cache.invalidateTags([`article:${id}`, 'article-list'])
      return toView(memo, users, updated!)
    },
  })

  router.defineRoute({
    method: 'patch',
    path: '/users/me',
    middlewares: [requireViewer],
    schema: (z) => ({
      body: z.object({ name: z.string().trim().min(1).max(100) }),
    }),
    meta: { summary: 'Rename the current user', tags: ['users'] },
    handler: async (ctx) => {
      const viewer = await viewerOf(ctx, users)
      const user = await db.users.rename(viewer!.id, ctx.req.body.name)
      // Every cached article shows the name of its author.
      await ctx.cache.invalidateTags(['articles'])
      ctx.memo.set(users, user!.id, user)
      return user
    },
  })

  return router
}
