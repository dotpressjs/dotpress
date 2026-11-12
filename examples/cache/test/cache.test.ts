import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startApp, stores } from './support.ts'

// ctx.cache: the same scenarios on every store (Redis with REDIS_URL).
describe.each(stores)('with the %s store', (_, createStore) => {
  let api: Awaited<ReturnType<typeof startApp>>
  let closeStore: () => Promise<void>

  beforeEach(async () => {
    const { store, close } = await createStore()
    closeStore = close
    api = await startApp(store)
  })

  afterEach(async () => {
    await api.close()
    await closeStore()
  })

  const read = async (path: string) => (await api.request(path)).json()

  it('serves an article from the cache', async () => {
    const first = await api.queriesOf(() => read('/articles/a1'))
    expect(first).toEqual(['articles.findById', 'users.findManyById'])

    const second = await api.queriesOf(async () => {
      expect(await read('/articles/a1')).toMatchObject({ title: 'Caching 101' })
    })
    expect(second).toEqual([])
  })

  it('does not cache unknown articles', async () => {
    expect((await api.request('/articles/nope')).status).toBe(404)

    const again = await api.queriesOf(() => api.request('/articles/nope'))
    expect(again).toEqual(['articles.findById'])
  })

  it('expires an article and the list when the article changes', async () => {
    await read('/articles/a1')
    await read('/articles/a2')
    await read('/articles')

    await api.patch('/articles/a1', { title: 'Caching 102' }, 'u1')

    const reads = await api.queriesOf(async () => {
      expect(await read('/articles/a1')).toMatchObject({ title: 'Caching 102' })
      expect(await read('/articles')).toContainEqual(
        expect.objectContaining({ id: 'a1', title: 'Caching 102' })
      )
      await read('/articles/a2') // another article: still cached
    })
    expect(reads).toEqual([
      'articles.findById',
      'users.findManyById',
      'articles.list',
      'users.findManyById',
    ])
  })

  it('expires every article when an author is renamed', async () => {
    await read('/articles/a1')
    await read('/articles/a2')
    await read('/articles')

    const res = await api.patch('/users/me', { name: 'Alice Martin' }, 'u1')
    expect(res.status).toBe(200)

    // The tag "articles": every cached view shows the name of its author.
    const reads = await api.queriesOf(async () => {
      expect(await read('/articles/a1')).toMatchObject({
        author: { id: 'u1', name: 'Alice Martin' },
      })
      await read('/articles/a2')
      await read('/articles')
    })
    expect(reads.filter((query) => query.startsWith('articles.'))).toEqual([
      'articles.findById',
      'articles.findById',
      'articles.list',
    ])
  })
})
