import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@dotpress/cache'
import {
  createCacheStore,
  type ClosableStore,
} from '../src/services/cache-store.ts'
import { startApp, type Session, type TestApi } from './support.ts'

// The dashboard of a project, cached: on memory, and on Redis with
// REDIS_URL (docker compose up -d; the CI has it).
const stores: [string, () => Promise<ClosableStore>][] = [
  [
    'memory',
    async () => ({ store: createMemoryStore(), close: async () => {} }),
  ],
]
const redisUrl = process.env.REDIS_URL
if (redisUrl) stores.push(['redis', () => createCacheStore(redisUrl)])

describe.each(stores)('with the %s store', (_, createStore) => {
  let api: TestApi
  let store: ClosableStore
  let alice: Session
  let bob: Session
  let projectId: string

  beforeEach(async () => {
    store = await createStore()
    api = await startApp({ cacheStore: store.store })
    alice = await api.signUp('Alice')
    bob = await api.signUp('Bob')
    projectId = await api.createProject(alice, 'Bob')
  })

  afterEach(async () => {
    await api.close()
    await store.close()
  })

  const stats = (session: Session) =>
    api.request(`/projects/${projectId}/stats`, { headers: session.headers })

  const countQueries = (queries: string[]) =>
    queries.filter((sql) => sql.includes('COUNT(*)'))

  it('serves the dashboard from the cache', async () => {
    const first = await api.queriesOf(() => stats(alice))
    expect(countQueries(first)).toHaveLength(1)

    // Another member: the same cached value.
    const second = await api.queriesOf(async () => {
      expect(await (await stats(bob)).json()).toMatchObject({ total: 0 })
    })
    expect(countQueries(second)).toEqual([])
  })

  it('expires it when a task changes', async () => {
    await stats(alice)
    const created = await api.send(
      'POST',
      `/projects/${projectId}/tasks`,
      { title: 'Review', assigneeId: bob.userId },
      alice.headers
    )
    const task = (await created.json()) as { id: string }
    expect(await (await stats(alice)).json()).toMatchObject({
      total: 1,
      byStatus: { todo: 1 },
    })

    await api.send(
      'PATCH',
      `/tasks/${task.id}`,
      { status: 'done' },
      bob.headers
    )
    expect(await (await stats(alice)).json()).toMatchObject({
      byStatus: { todo: 0, done: 1 },
    })
  })

  it('checks the access on every request, even when cached', async () => {
    await stats(alice)
    const eve = await api.signUp('Eve')

    expect((await stats(eve)).status).toBe(404)
  })
})
