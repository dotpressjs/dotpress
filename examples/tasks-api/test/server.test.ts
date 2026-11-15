import { fastifyAdapter } from '@dotpress/adapter-fastify'
import { createMemoryStore } from '@dotpress/cache'
import { createFakeEventBus } from '@dotpress/events'
import { createMemoryLogger } from '@dotpress/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTasksApp } from '../src/http/app.ts'
import { generateKeys } from '../src/features/auth/keys.ts'
import { openDatabase } from '../src/db/database.ts'
import { createRepositories } from '../src/services/index.ts'
import { DEMO_PASSWORD, seedDemo } from '../src/demo-data.ts'

// The seeded app on a real Fastify server, reached over HTTP.
let baseUrl: string
let close: () => Promise<void>

beforeAll(async () => {
  const db = openDatabase(':memory:')
  await seedDemo(db, 4)
  const adapter = fastifyAdapter()
  const app = await createTasksApp({
    adapter,
    repositories: createRepositories(db),
    keys: generateKeys(),
    publicUrl: 'https://tasks.example.com',
    cacheStore: createMemoryStore(),
    // The notifications are tested elsewhere.
    events: createFakeEventBus(),
    logger: createMemoryLogger(),
  })
  const { port } = await app.listen(0, '127.0.0.1')
  baseUrl = `http://127.0.0.1:${port}`
  close = async () => {
    await app.close()
    db.close()
  }
})

afterAll(() => close())

it('serves the demo data to Bob over HTTP', async () => {
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'bob@example.com',
      password: DEMO_PASSWORD,
    }),
  })
  const { accessToken } = (await login.json()) as { accessToken: string }
  const headers = { authorization: `Bearer ${accessToken}` }

  const projects = (await (
    await fetch(`${baseUrl}/projects`, { headers })
  ).json()) as { id: string; name: string; role: string }[]
  expect(projects).toEqual([
    expect.objectContaining({ name: 'Website launch', role: 'member' }),
  ])

  const stats = await fetch(`${baseUrl}/projects/${projects[0]!.id}/stats`, {
    headers,
  })
  expect(await stats.json()).toMatchObject({
    total: 3,
    byStatus: { todo: 1, doing: 1, done: 1 },
    // By name, the unassigned tasks last.
    byAssignee: [
      { assignee: { name: 'Alice' }, done: 1 },
      { assignee: { name: 'Bob' }, doing: 1 },
      { assignee: null, todo: 1 },
    ],
  })
})
