import { afterEach, beforeEach, expect, it } from 'vitest'
import { startApp, type Session, type TestApi } from './support.ts'

// Who may do what: members only, the owner for the members.
let api: TestApi
let alice: Session
let bob: Session
let eve: Session
let projectId: string

beforeEach(async () => {
  api = await startApp()
  alice = await api.signUp('Alice')
  bob = await api.signUp('Bob')
  eve = await api.signUp('Eve')
  projectId = await api.createProject(alice, 'Bob')
})

afterEach(() => api.close())

it('requires a user', async () => {
  for (const path of ['/projects', `/projects/${projectId}/tasks`]) {
    const res = await api.request(path)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
  }
})

it('hides the projects of others: 404, not 403', async () => {
  const task = await api.send(
    'POST',
    `/projects/${projectId}/tasks`,
    { title: 'Secret' },
    alice.headers
  )
  const { id: taskId } = (await task.json()) as { id: string }

  for (const path of [
    `/projects/${projectId}`,
    `/projects/${projectId}/tasks`,
    `/projects/${projectId}/stats`,
    `/tasks/${taskId}`,
  ]) {
    expect((await api.request(path, { headers: eve.headers })).status).toBe(404)
  }
  const update = await api.send(
    'PATCH',
    `/tasks/${taskId}`,
    { status: 'done' },
    eve.headers
  )
  expect(update.status).toBe(404)

  const list = await api.request('/projects', { headers: eve.headers })
  expect(await list.json()).toEqual([])
})

it('lets the owner only add members', async () => {
  const byMember = await api.send(
    'POST',
    `/projects/${projectId}/members`,
    { email: 'eve@example.com' },
    bob.headers
  )
  expect(byMember.status).toBe(403)

  const twice = await api.send(
    'POST',
    `/projects/${projectId}/members`,
    { email: 'bob@example.com' },
    alice.headers
  )
  expect(twice.status).toBe(409)

  const unknown = await api.send(
    'POST',
    `/projects/${projectId}/members`,
    { email: 'nobody@example.com' },
    alice.headers
  )
  expect(unknown.status).toBe(404)
})

it('assigns tasks to members only', async () => {
  const res = await api.send(
    'POST',
    `/projects/${projectId}/tasks`,
    { title: 'Review', assigneeId: eve.userId },
    alice.headers
  )
  expect(res.status).toBe(422)
})
