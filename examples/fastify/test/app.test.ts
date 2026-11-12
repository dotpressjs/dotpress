import { createMemoryLogger } from '@dotpress/testing'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createNotesApp } from '../src/app.ts'
import type { Note } from '../src/notes.ts'

// inject() of Fastify sends requests without opening a port.
let app: Awaited<ReturnType<typeof createNotesApp>>

beforeEach(async () => {
  app = await createNotesApp({ logger: createMemoryLogger() })
})

afterEach(() => app.close())

it('creates a note and reads it back', async () => {
  const created = await app.native().inject({
    method: 'POST',
    url: '/notes',
    payload: { text: 'Hello Fastify' },
  })
  expect(created.statusCode).toBe(201)
  const note = created.json<Note>()
  expect(note.text).toBe('Hello Fastify')

  const read = await app.native().inject(`/notes/${note.id}`)
  expect(read.statusCode).toBe(200)
  expect(read.json()).toEqual(note)

  const list = await app.native().inject('/notes')
  expect(list.json()).toEqual([note])
})

it('validates the body', async () => {
  const res = await app.native().inject({
    method: 'POST',
    url: '/notes',
    payload: { text: '' },
  })

  expect(res.statusCode).toBe(400)
  expect(res.json()).toMatchObject({ error: 'VALIDATION_FAILED' })
})

it('returns not found for an unknown note', async () => {
  const res = await app.native().inject('/notes/unknown')

  expect(res.statusCode).toBe(404)
  expect(res.json()).toMatchObject({ message: 'Note not found' })
})

it('applies the Fastify hooks to the Dotpress routes', async () => {
  const res = await app.native().inject('/notes')

  expect(res.headers['x-request-id']).toBeDefined()
})

it('keeps the native Fastify routes', async () => {
  const res = await app.native().inject('/health')

  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ status: 'ok' })
})
