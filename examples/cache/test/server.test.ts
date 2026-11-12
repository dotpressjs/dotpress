import type { AddressInfo } from 'node:net'
import { expressAdapter } from '@dotpress/adapter-express'
import { createMemoryStore } from '@dotpress/cache'
import { createMemoryLogger } from '@dotpress/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createArticlesApp } from '../src/app.ts'
import { createDatabase } from '../src/db.ts'
import { createStore } from '../src/store.ts'

// The app on a real Express server, reached over HTTP.
let baseUrl: string
const db = createDatabase()
let close: () => Promise<void>

beforeAll(async () => {
  const adapter = expressAdapter()
  const app = await createArticlesApp({
    adapter,
    store: createMemoryStore(),
    db,
    logger: createMemoryLogger(),
  })
  await app.listen(0, '127.0.0.1')

  const { port } = adapter.server()!.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
  close = () => app.close()
})

afterAll(() => close())

it('serves the articles over HTTP, from the cache the second time', async () => {
  const first = await fetch(`${baseUrl}/articles`)
  expect(first.status).toBe(200)
  const before = db.queries.length

  const second = await fetch(`${baseUrl}/articles`)
  expect(await second.json()).toHaveLength(3)
  expect(db.queries.length).toBe(before)
})

it('uses the memory store without REDIS_URL', async () => {
  const { store, close } = await createStore({})
  expect(store.name).toBe('memory')
  await close()
})
