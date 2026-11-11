import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTasksApp } from '../src/app.ts'
import type { Task } from '../src/tasks.ts'

// The memory adapter runs requests in memory, without opening a port: fast
// tests of the app as configured in production.
let adapter: ReturnType<typeof memoryAdapter>
let close: () => Promise<void>

beforeEach(async () => {
  adapter = memoryAdapter()
  const app = await createTasksApp({ adapter, logger: createMemoryLogger() })
  close = () => app.close()
})

afterEach(() => close())

const request = (path: string, init?: RequestInit) =>
  adapter.fetch(new Request(`http://localhost${path}`, init))

const send = (method: string, path: string, body: unknown) =>
  request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const createTask = async (title: string) =>
  (await (await send('POST', '/tasks', { title })).json()) as Task

const ids = (tasks: Task[]) => tasks.map((task) => task.id)

describe('tasks', () => {
  it('creates a task and reads it back', async () => {
    const res = await send('POST', '/tasks', { title: '  Write the docs ' })
    expect(res.status).toBe(201)

    const task = (await res.json()) as Task
    expect(task).toEqual({
      id: expect.any(String),
      title: 'Write the docs',
      done: false,
      createdAt: expect.any(String),
    })

    const read = await request(`/tasks/${task.id}`)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual(task)
  })

  it('rejects an invalid body with the validation issues', async () => {
    const res = await send('POST', '/tasks', { title: '' })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      status: 400,
      error: 'VALIDATION_FAILED',
      data: { issues: [{ source: 'body', path: ['title'] }] },
    })
  })

  it('returns a conflict for a duplicate title', async () => {
    await createTask('Write the docs')
    const res = await send('POST', '/tasks', { title: 'write the DOCS' })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      status: 409,
      error: 'CONFLICT',
      message: 'A task with this title already exists',
    })
  })

  it('returns not found for an unknown task', async () => {
    const res = await request('/tasks/unknown')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: 'NOT_FOUND',
      message: 'Task not found',
    })
  })

  it('updates a task, and filters the list', async () => {
    const docs = await createTask('Write the docs')
    const tests = await createTask('Write the tests')

    const res = await send('PATCH', `/tasks/${docs.id}`, { done: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      title: 'Write the docs',
      done: true,
    })

    const done = (await (await request('/tasks?done=true')).json()) as Task[]
    expect(ids(done)).toEqual([docs.id])

    const todo = (await (await request('/tasks?done=false')).json()) as Task[]
    expect(ids(todo)).toEqual([tests.id])

    const all = await (await request('/tasks')).json()
    expect(all).toHaveLength(2)
  })

  it('refuses to rename a task to the title of another one', async () => {
    const docs = await createTask('Write the docs')
    await createTask('Write the tests')

    const res = await send('PATCH', `/tasks/${docs.id}`, {
      title: 'Write the tests',
    })
    expect(res.status).toBe(409)

    const same = await send('PATCH', `/tasks/${docs.id}`, {
      title: 'Write the docs',
    })
    expect(same.status).toBe(200)
  })

  it('deletes a task', async () => {
    const task = await createTask('Write the docs')

    const res = await request(`/tasks/${task.id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')

    expect((await request(`/tasks/${task.id}`)).status).toBe(404)
    expect(
      (await request(`/tasks/${task.id}`, { method: 'DELETE' })).status
    ).toBe(404)
  })
})

interface OpenApiDocument {
  info: unknown
  paths: Record<string, Record<string, { responses: object }>>
  components: { schemas: Record<string, unknown> }
}

describe('documentation', () => {
  it('generates the OpenAPI document from the routes', async () => {
    const res = await request('/openapi.json')
    expect(res.status).toBe(200)

    const document = (await res.json()) as OpenApiDocument
    expect(document.info).toEqual({ title: 'Tasks API', version: '1.0.0' })
    expect(Object.keys(document.paths)).toEqual(['/tasks', '/tasks/{id}'])
    expect(document.components.schemas.Task).toBeDefined()
    expect(document.paths['/tasks'].post.responses).toHaveProperty('409')
    expect(document.paths['/tasks/{id}'].delete.responses).toHaveProperty('204')
  })

  it('serves the API reference', async () => {
    const res = await request('/docs')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
  })
})
