import { expectMailSent } from '@dotpress/testing'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  taskAssignedMail,
  taskCompletedMail,
} from '../src/notifications/mails.ts'
import { startApp, type TestApi } from './support.ts'

// The story of the demo, step by step (see the README).
let api: TestApi

beforeEach(async () => {
  api = await startApp()
})

afterEach(() => api.close())

it('runs the story of the demo', async () => {
  // 1. Alice and Bob sign up; Bob's language is French.
  const alice = await api.signUp('Alice')
  const bob = await api.signUp('Bob', { language: 'fr-FR,fr;q=0.9' })
  const me = await api.request('/auth/me', { headers: bob.headers })
  expect(await me.json()).toMatchObject({ name: 'Bob', locale: 'fr' })

  // 2. Alice creates a project, and adds Bob.
  const created = await api.send(
    'POST',
    '/projects',
    { name: 'Website launch' },
    alice.headers
  )
  expect(created.status).toBe(201)
  const project = (await created.json()) as { id: string }
  const added = await api.send(
    'POST',
    `/projects/${project.id}/members`,
    { email: 'bob@example.com' },
    alice.headers
  )
  expect(added.status).toBe(201)

  // 3. Alice creates a task for Bob.
  const task = await api.send(
    'POST',
    `/projects/${project.id}/tasks`,
    { title: 'Write the homepage copy', assigneeId: bob.userId },
    alice.headers
  )
  expect(task.status).toBe(201)
  const { id: taskId } = (await task.json()) as { id: string }

  // The response did not wait for the email: a listener sends it to Bob,
  // in French.
  await api.drain()
  expectMailSent(
    api.outbox,
    {
      to: 'bob@example.com',
      template: taskAssignedMail,
      locale: 'fr',
      subject: 'Nouvelle tâche pour vous : Write the homepage copy',
    },
    { times: 1 }
  )

  // 4. Bob finds it in his tasks.
  const mine = await api.request(
    `/projects/${project.id}/tasks?assignee=${bob.userId}`,
    { headers: bob.headers }
  )
  expect(await mine.json()).toEqual([
    expect.objectContaining({
      title: 'Write the homepage copy',
      status: 'todo',
      assignee: { id: bob.userId, name: 'Bob' },
    }),
  ])

  // 5. Bob completes it.
  const done = await api.send(
    'PATCH',
    `/tasks/${taskId}`,
    { status: 'done' },
    bob.headers
  )
  expect(await done.json()).toMatchObject({ status: 'done' })

  // Alice, who created the task, is told, in English.
  await api.drain()
  const mail = expectMailSent(api.outbox, {
    to: 'alice@example.com',
    template: taskCompletedMail,
    locale: 'en',
    subject: 'Task completed: Write the homepage copy',
  })
  expect(mail.text).toContain('Bob completed the task')
  expect(api.outbox.sent).toHaveLength(2)

  // 6. The dashboard of the project.
  const stats = await api.request(`/projects/${project.id}/stats`, {
    headers: alice.headers,
  })
  expect(await stats.json()).toEqual({
    total: 1,
    byStatus: { todo: 0, doing: 0, done: 1 },
    byAssignee: [
      { assignee: { id: bob.userId, name: 'Bob' }, todo: 0, doing: 0, done: 1 },
    ],
  })
})
