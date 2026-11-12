import { afterEach, beforeEach, expect, it } from 'vitest'
import { startApp } from './support.ts'

// ctx.memo: a value is loaded once per request, and the ids requested
// together are loaded in one query.
let api: Awaited<ReturnType<typeof startApp>>

beforeEach(async () => {
  api = await startApp()
})

afterEach(() => api.close())

it('loads the authors of a list with one query, not one per article', async () => {
  const queries = await api.queriesOf(async () => {
    const res = await api.request('/articles')
    expect(await res.json()).toEqual([
      expect.objectContaining({
        id: 'a1',
        author: { id: 'u1', name: 'Alice' },
      }),
      expect.objectContaining({ id: 'a2', author: { id: 'u2', name: 'Bob' } }),
      expect.objectContaining({
        id: 'a3',
        author: { id: 'u1', name: 'Alice' },
      }),
    ])
  })

  // 3 articles, 2 distinct authors: one batch.
  expect(queries).toEqual(['articles.list', 'users.findManyById'])
})

it('shares the current user between the middleware and the handler', async () => {
  const queries = await api.queriesOf(async () => {
    const res = await api.patch('/articles/a1', { title: 'Caching 102' }, 'u1')
    expect(res.status).toBe(200)
  })

  // The middleware loads the user, the handler reads it from the memo, and
  // the view of the article reuses it for the author.
  expect(queries.filter((query) => query.startsWith('users.'))).toEqual([
    'users.findManyById',
  ])
})

it('starts a new memo for each request', async () => {
  const queries = await api.queriesOf(async () => {
    await api.patch('/articles/a1', { title: 'One' }, 'u1')
    await api.patch('/articles/a1', { title: 'Two' }, 'u1')
  })

  expect(queries.filter((query) => query.startsWith('users.'))).toHaveLength(2)
})

it('rejects unknown users, and other authors', async () => {
  expect((await api.patch('/articles/a1', { title: 'X' })).status).toBe(401)
  expect(
    (await api.patch('/articles/a1', { title: 'X' }, 'nobody')).status
  ).toBe(401)
  expect((await api.patch('/articles/a1', { title: 'X' }, 'u2')).status).toBe(
    403
  )
})
