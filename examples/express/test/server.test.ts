import type { AddressInfo } from 'node:net'
import { expressAdapter } from '@dotpress/adapter-express'
import { createMemoryLogger } from '@dotpress/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTasksApp } from '../src/app.ts'
import type { Task } from '../src/tasks.ts'

// The same app on a real Express server, reached over HTTP.
let baseUrl: string
let close: () => Promise<void>

beforeAll(async () => {
  const adapter = expressAdapter()
  const app = await createTasksApp({ adapter, logger: createMemoryLogger() })
  await app.listen(0, '127.0.0.1')

  const { port } = adapter.server()!.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
  close = () => app.close()
})

afterAll(() => close())

it('serves the tasks over HTTP', async () => {
  const created = await fetch(`${baseUrl}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Write the docs' }),
  })
  expect(created.status).toBe(201)
  const task = (await created.json()) as Task

  const list = await fetch(`${baseUrl}/tasks`)
  expect(list.status).toBe(200)
  expect(await list.json()).toEqual([task])

  const invalid = await fetch(`${baseUrl}/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: '{"done":',
  })
  expect(invalid.status).toBe(400)
})

it('serves the documentation', async () => {
  const document = await fetch(`${baseUrl}/openapi.json`)
  expect(document.status).toBe(200)

  const page = await fetch(`${baseUrl}/docs`)
  expect(page.status).toBe(200)
})
