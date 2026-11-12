import { honoAdapter } from '@dotpress/adapter-hono'
import { createMemoryLogger } from '@dotpress/testing'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createNotesApp, honoOptions } from '../src/app.ts'
import type { Note } from '../src/notes.ts'

// adapter.fetch() handles a Web Request in memory, like app.fetch() in Hono.
let adapter: ReturnType<typeof honoAdapter>
let close: () => Promise<void>

beforeEach(async () => {
  adapter = honoAdapter(honoOptions)
  const app = await createNotesApp(adapter, { logger: createMemoryLogger() })
  close = () => app.close()
})

afterEach(() => close())

const request = (path: string, init?: RequestInit) =>
  adapter.fetch(new Request(`http://localhost${path}`, init))

const post = (text: string) =>
  request('/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })

it('creates a note and reads it back', async () => {
  const created = await post('Hello Hono')
  expect(created.status).toBe(201)
  const note = (await created.json()) as Note

  const read = await request(`/notes/${note.id}`)
  expect(read.status).toBe(200)
  expect(await read.json()).toEqual(note)

  const list = await request('/notes')
  expect(await list.json()).toEqual([note])
})

it('validates the body', async () => {
  const res = await post('')

  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ error: 'VALIDATION_FAILED' })
})

it('returns not found for an unknown note', async () => {
  const res = await request('/notes/unknown')

  expect(res.status).toBe(404)
  expect(await res.json()).toMatchObject({ message: 'Note not found' })
})

it('applies the Hono middlewares to the Dotpress routes', async () => {
  const res = await request('/notes')

  // secureHeaders()
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
})

it('keeps the native Hono routes', async () => {
  const res = await request('/health')

  expect(await res.json()).toEqual({ status: 'ok' })
})
