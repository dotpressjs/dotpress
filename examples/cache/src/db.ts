export interface User {
  id: string
  name: string
}

export interface Article {
  id: string
  title: string
  authorId: string
  updatedAt: string
}

/**
 * A fake database in memory, to replace with yours. It records its queries
 * (`queries`): the tests count them, as you would watch the queries of a
 * real database.
 */
export const createDatabase = () => {
  const users = new Map<string, User>(
    [
      { id: 'u1', name: 'Alice' },
      { id: 'u2', name: 'Bob' },
    ].map((user) => [user.id, user])
  )
  const now = new Date().toISOString()
  const articles = new Map<string, Article>(
    [
      { id: 'a1', title: 'Caching 101', authorId: 'u1', updatedAt: now },
      { id: 'a2', title: 'Batching loads', authorId: 'u2', updatedAt: now },
      { id: 'a3', title: 'Cache tags', authorId: 'u1', updatedAt: now },
    ].map((article) => [article.id, article])
  )
  const queries: string[] = []
  const query = <T>(name: string, run: () => T): Promise<T> => {
    queries.push(name)
    // Copies: like a database, it never returns its own objects.
    return Promise.resolve(structuredClone(run()))
  }

  return {
    queries,
    users: {
      findManyById: (ids: readonly string[]) =>
        query('users.findManyById', () =>
          ids.flatMap((id) => users.get(id) ?? [])
        ),
      rename: (id: string, name: string) =>
        query('users.rename', () => {
          const user = users.get(id)
          if (user) user.name = name
          return user
        }),
    },
    articles: {
      list: () => query('articles.list', () => [...articles.values()]),
      findById: (id: string) =>
        query('articles.findById', () => articles.get(id)),
      update: (id: string, title: string) =>
        query('articles.update', () => {
          const article = articles.get(id)
          if (article) {
            article.title = title
            article.updatedAt = new Date().toISOString()
          }
          return article
        }),
    },
  }
}

export type Database = ReturnType<typeof createDatabase>
