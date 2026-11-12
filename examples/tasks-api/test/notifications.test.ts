import { randomUUID } from 'node:crypto'
import { createFakeEventBus, createWorker } from '@dotpress/events'
import { createMemoryProvider, type MailProvider } from '@dotpress/mailer'
import {
  expectEventEmitted,
  expectEventNotEmitted,
  expectMailSent,
  expectNoMailSent,
} from '@dotpress/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { taskAssignedMail } from '../src/features/notifications/mails.ts'
import { taskAssigned, taskCompleted } from '../src/features/tasks/events.ts'
import { startApp, type Session, type TestApi } from './support.ts'

let api: TestApi

afterEach(() => api.close())

/** Alice owns a project, Bob is a member. */
const setUp = async (options: Parameters<typeof startApp>[0] = {}) => {
  api = await startApp(options)
  const alice = await api.signUp('Alice')
  const bob = await api.signUp('Bob', { language: 'fr' })
  const projectId = await api.createProject(alice, 'Bob')
  const createTask = async (by: Session, assigneeId?: string) => {
    const res = await api.send(
      'POST',
      `/projects/${projectId}/tasks`,
      { title: 'Review', assigneeId },
      by.headers
    )
    return ((await res.json()) as { id: string }).id
  }
  const patch = (by: Session, taskId: string, body: unknown) =>
    api.send('PATCH', `/tasks/${taskId}`, body, by.headers)
  return { alice, bob, createTask, patch }
}

// The routes emit the events; a fake bus records them without running the
// listeners.
describe('events', () => {
  const events = () => createFakeEventBus()

  it('emits task.assigned when someone else is assigned', async () => {
    const bus = events()
    const { alice, bob, createTask, patch } = await setUp({ events: bus })

    const taskId = await createTask(alice, bob.userId)
    // Reassigned to the same person, or to oneself: no event.
    await patch(alice, taskId, { assigneeId: bob.userId })
    await patch(alice, taskId, { assigneeId: alice.userId })
    await createTask(alice, alice.userId)

    expectEventEmitted(
      bus,
      taskAssigned,
      { taskId, assigneeId: bob.userId, assignedBy: alice.userId },
      { times: 1 }
    )
    expect(
      bus.emitted.filter((emission) => emission.event === taskAssigned.name)
    ).toHaveLength(1)
  })

  it('emits task.completed once, when a task becomes done', async () => {
    const bus = events()
    const { alice, bob, createTask, patch } = await setUp({ events: bus })
    const taskId = await createTask(alice, bob.userId)

    await patch(bob, taskId, { status: 'doing' })
    expectEventNotEmitted(bus, taskCompleted)
    await patch(bob, taskId, { status: 'done' })
    await patch(bob, taskId, { status: 'done', title: 'Reviewed' })

    expectEventEmitted(
      bus,
      taskCompleted,
      { taskId, completedBy: bob.userId },
      // The request ID links the logs of the listener to the request.
      { times: 1, metadata: { requestId: expect.any(String) } }
    )
  })
})

describe('listeners', () => {
  it('does not tell the creator about their own completed task', async () => {
    const { alice, createTask, patch } = await setUp()
    const taskId = await createTask(alice)

    await patch(alice, taskId, { status: 'done' })
    await api.drain()

    expectNoMailSent(api.outbox)
  })

  it('sends one email when a message is delivered twice', async () => {
    const { alice, bob, createTask } = await setUp()
    await createTask(alice, bob.userId)
    await api.drain()

    // The same message again, as a queue may deliver it after a timeout.
    const message = api.transport.sent.find(
      (envelope) => envelope.listener === 'notify-assignee'
    )
    const worker = createWorker({ listeners: api.listeners })
    expect(await worker.handle(JSON.stringify(message))).toEqual({
      status: 'success',
    })

    expectMailSent(api.outbox, { to: 'bob@example.com' }, { times: 1 })
  })

  it('ignores a message about a task reassigned since', async () => {
    const { alice, bob, createTask, patch } = await setUp()
    const taskId = await createTask(alice, bob.userId)
    await api.drain()
    await patch(alice, taskId, { assigneeId: null })

    // A later message of the same assignment (another id): Bob is no
    // longer the assignee.
    const message = api.transport.sent.find(
      (envelope) => envelope.listener === 'notify-assignee'
    )!
    const worker = createWorker({ listeners: api.listeners })
    await worker.handle(JSON.stringify({ ...message, id: randomUUID() }))

    expectMailSent(api.outbox, { to: 'bob@example.com' }, { times: 1 })
  })

  it('retries when the email cannot be sent', async () => {
    const outbox = createMemoryProvider()
    let failures = 1
    const flaky: MailProvider = {
      name: 'flaky',
      send: async (message) => {
        if (failures-- > 0) throw new Error('SMTP server unavailable')
        return outbox.send(message)
      },
    }
    const { alice, bob, createTask } = await setUp({ mailProvider: flaky })

    await createTask(alice, bob.userId)
    await api.drain()

    expectMailSent(outbox, { template: taskAssignedMail }, { times: 1 })
    expect(api.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        args: [
          expect.objectContaining({ listener: 'notify-assignee', attempt: 1 }),
          'Event listener failed, the message is retried',
        ],
      })
    )
  })
})
