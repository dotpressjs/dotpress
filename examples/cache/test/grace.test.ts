import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startApp } from './support.ts'

// The grace period: once the 10 minutes of an article are over, a failing
// database still gets the last value, for one more day.
let api: Awaited<ReturnType<typeof startApp>>

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  api = await startApp()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await api.close()
})

const later = (minutes: number) =>
  vi.setSystemTime(Date.now() + minutes * 60 * 1000)

it('serves the expired article when the database fails', async () => {
  await api.request('/articles/a1')
  later(11)
  vi.spyOn(api.db.articles, 'findById').mockRejectedValue(
    new Error('Connection lost')
  )

  const res = await api.request('/articles/a1')

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ id: 'a1', title: 'Caching 101' })
})

it('reloads the expired article when the database works', async () => {
  await api.request('/articles/a1')
  later(11)

  const queries = await api.queriesOf(() => api.request('/articles/a1'))

  expect(queries).toContain('articles.findById')
})

it('fails without a value to serve', async () => {
  vi.spyOn(api.db.articles, 'findById').mockRejectedValue(
    new Error('Connection lost')
  )

  const res = await api.request('/articles/a1')

  expect(res.status).toBe(500)
})

it('fails after the grace period', async () => {
  await api.request('/articles/a1')
  later(10 + 24 * 60 + 1)
  vi.spyOn(api.db.articles, 'findById').mockRejectedValue(
    new Error('Connection lost')
  )

  expect((await api.request('/articles/a1')).status).toBe(500)
})
