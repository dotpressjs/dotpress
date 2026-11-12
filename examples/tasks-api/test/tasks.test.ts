import { afterEach, beforeEach, expect, it } from 'vitest'
import { startApp, type Session, type TestApi } from './support.ts'

let api: TestApi
let alice: Session
let bob: Session
let projectId: string

beforeEach(async () => {
  api = await startApp()
  alice = await api.signUp('Alice')
  bob = await api.signUp('Bob')
  projectId = await api.createProject(alice, 'Bob')
})

afterEach(() => api.close())

const createTask = async (title: string, assigneeId?: string) => {
  const res = await api.send(
    'POST',
    `/projects/${projectId}/tasks`,
    { title, assigneeId },
    alice.headers
  )
  return (await res.json()) as { id: string }
}

it('filters the tasks by status and assignee', async () => {
  const first = await createTask('First', bob.userId)
  await createTask('Second', alice.userId)
  await createTask('Third')
  await api.send(
    'PATCH',
    `/tasks/${first.id}`,
    { status: 'doing' },
    bob.headers
  )

  const titles = async (query: string) => {
    const res = await api.request(`/projects/${projectId}/tasks${query}`, {
      headers: alice.headers,
    })
    return ((await res.json()) as { title: string }[]).map((task) => task.title)
  }
  expect(await titles('')).toEqual(['First', 'Second', 'Third'])
  expect(await titles('?status=todo')).toEqual(['Second', 'Third'])
  expect(await titles(`?assignee=${bob.userId}`)).toEqual(['First'])
  const invalid = await api.request(
    `/projects/${projectId}/tasks?status=late`,
    {
      headers: alice.headers,
    }
  )
  expect(invalid.status).toBe(400)
})

it('rejects invalid input with the validation issues', async () => {
  const res = await api.send(
    'POST',
    `/projects/${projectId}/tasks`,
    { title: '' },
    alice.headers
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({
    error: 'VALIDATION_FAILED',
    data: { issues: [{ source: 'body', path: ['title'] }] },
  })
})

it('unassigns a task with null', async () => {
  const task = await createTask('Review', bob.userId)
  const res = await api.send(
    'PATCH',
    `/tasks/${task.id}`,
    { assigneeId: null },
    alice.headers
  )
  expect(await res.json()).toMatchObject({ assignee: null })
})

it('loads the assignees of a list with one query (memo)', async () => {
  await createTask('First', bob.userId)
  await createTask('Second', alice.userId)
  await createTask('Third', bob.userId)

  const queries = await api.queriesOf(() =>
    api.request(`/projects/${projectId}/tasks`, { headers: alice.headers })
  )

  // Three tasks, two assignees: one batch.
  expect(
    queries.filter((sql) => sql.includes('FROM users WHERE id IN'))
  ).toHaveLength(1)
})

it('checks the membership once per request (memo)', async () => {
  const task = await createTask('Review')

  // Alice assigns the task to herself: her role is checked for the access,
  // then for the assignee.
  const queries = await api.queriesOf(() =>
    api.send(
      'PATCH',
      `/tasks/${task.id}`,
      { assigneeId: alice.userId },
      alice.headers
    )
  )

  expect(
    queries.filter((sql) => sql.includes('FROM project_members WHERE'))
  ).toHaveLength(1)
})

it('shares the role between the middleware of the group and the handler', async () => {
  // requireMember loads the role of Alice, the handler reads it again to
  // return it: one query.
  const queries = await api.queriesOf(() =>
    api.request(`/projects/${projectId}`, { headers: alice.headers })
  )

  expect(
    queries.filter((sql) => sql.includes('FROM project_members WHERE'))
  ).toHaveLength(1)
})
