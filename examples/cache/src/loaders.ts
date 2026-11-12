import { defineCacheEntry, defineMemo, type Memo } from '@dotpress/cache'
import { z } from 'zod'
import type { Article, Database } from './db.ts'

/**
 * Memo of the users: loaded once per request, and in batches. The ids
 * requested in the same tick are loaded with one query.
 */
export const userMemo = (db: Database) =>
  defineMemo({
    name: 'user',
    batch: async (ids: readonly string[]) => {
      const users = await db.users.findManyById(ids)
      // A Map by id: unknown ids give undefined.
      return new Map(users.map((user) => [user.id, user]))
    },
  })

export type UserMemo = ReturnType<typeof userMemo>

export const ArticleView = z
  .object({
    id: z.string(),
    title: z.string(),
    author: z.object({ id: z.string(), name: z.string() }).nullable(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Article' })

/** An article with the name of its author, as the API returns it. */
export const toView = async (
  memo: Memo,
  users: UserMemo,
  article: Article
): Promise<z.infer<typeof ArticleView>> => {
  const author = await memo(users, article.authorId)
  return {
    id: article.id,
    title: article.title,
    author: author ? { id: author.id, name: author.name } : null,
    updatedAt: article.updatedAt,
  }
}

// Values shared across requests and instances. Every view of an article
// holds the name of its author: renaming a user expires them all with the
// `articles` tag.

/** One article: 10 minutes, then served for one more day if the database fails. */
export const articleCache = defineCacheEntry({
  name: 'article',
  key: (id: string) => id,
  // Values read back are checked: a value written by an older version of
  // the app that no longer matches is a miss, not a crash.
  schema: ArticleView,
  ttl: '10m',
  grace: '1d',
  tags: (id: string) => [`article:${id}`, 'articles'],
})

/** The list of the articles. */
export const articleListCache = defineCacheEntry({
  name: 'article-list',
  key: () => 'all',
  schema: z.array(ArticleView),
  ttl: '1m',
  tags: () => ['articles', 'article-list'],
})
