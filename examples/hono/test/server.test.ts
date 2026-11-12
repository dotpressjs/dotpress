import type { AddressInfo } from 'node:net'
import { honoAdapter } from '@dotpress/adapter-hono/node'
import { createMemoryLogger } from '@dotpress/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createNotesApp, honoOptions } from '../src/app.ts'

// The app served by Node.js (@hono/node-server), reached over HTTP.
let baseUrl: string
let close: () => Promise<void>

beforeAll(async () => {
  const adapter = honoAdapter(honoOptions)
  const app = await createNotesApp(adapter, { logger: createMemoryLogger() })
  await app.listen(0, '127.0.0.1')

  const { port } = adapter.server()!.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
  close = () => app.close()
})

afterAll(() => close())

it('serves the notes and the native routes over HTTP', async () => {
  const created = await fetch(`${baseUrl}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hello Hono' }),
  })
  expect(created.status).toBe(201)

  const list = await fetch(`${baseUrl}/notes`)
  expect(list.status).toBe(200)
  expect(list.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await list.json()).toHaveLength(1)

  const health = await fetch(`${baseUrl}/health`)
  expect(await health.json()).toEqual({ status: 'ok' })
})
