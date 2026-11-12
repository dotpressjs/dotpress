import type { AddressInfo } from 'node:net'
import { createMemoryLogger } from '@dotpress/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createNotesApp } from '../src/app.ts'

// The app on a real Fastify server, reached over HTTP.
let baseUrl: string
let close: () => Promise<void>

beforeAll(async () => {
  const app = await createNotesApp({ logger: createMemoryLogger() })
  await app.listen(0, '127.0.0.1')

  const { port } = app.native().server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
  close = () => app.close()
})

afterAll(() => close())

it('serves the notes and the native routes over HTTP', async () => {
  const created = await fetch(`${baseUrl}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hello Fastify' }),
  })
  expect(created.status).toBe(201)

  const list = await fetch(`${baseUrl}/notes`)
  expect(list.status).toBe(200)
  expect(list.headers.get('x-request-id')).not.toBeNull()
  expect(await list.json()).toHaveLength(1)

  const health = await fetch(`${baseUrl}/health`)
  expect(await health.json()).toEqual({ status: 'ok' })
})
