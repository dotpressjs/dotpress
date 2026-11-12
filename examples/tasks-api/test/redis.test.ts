import { createWorker, startWorker } from '@dotpress/events'
import { createBullmqSource } from '@dotpress/events/bullmq'
import { expectMailSent } from '@dotpress/testing'
import { afterEach, describe, it, vi } from 'vitest'
import { createTransport, redisConnection } from '../src/services/bus.ts'
import { taskAssignedMail } from '../src/features/notifications/mails.ts'
import { startApp, type TestApi } from './support.ts'

// The production setup: the API queues the events in Redis (BullMQ), and a
// worker runs the listeners. Here the worker runs in the test process; in
// production, `npm run worker` runs it in its own.
// REDIS_URL=redis://localhost:6379 (docker compose up -d); the CI has it.
const redisUrl = process.env.REDIS_URL

describe.skipIf(!redisUrl)('with Redis', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it(
    'sends the notifications through the queue and the worker',
    { timeout: 20_000 },
    async () => {
      const config = {
        REDIS_URL: redisUrl,
        // A queue of its own: tests running at the same time do not share it.
        EVENTS_QUEUE: `tasks-api-test-${process.pid}-${Date.now()}`,
      }
      const transport = createTransport(config)
      const api: TestApi = await startApp({ transport })
      cleanups.push(
        () => api.close(),
        () => transport.close()
      )

      const worker = startWorker(
        createWorker({ listeners: api.listeners }),
        createBullmqSource({
          name: config.EVENTS_QUEUE,
          connection: redisConnection(redisUrl!),
        })
      )
      cleanups.push(() => worker.stop())

      const alice = await api.signUp('Alice')
      const bob = await api.signUp('Bob', { language: 'fr' })
      const projectId = await api.createProject(alice, 'Bob')
      await api.send(
        'POST',
        `/projects/${projectId}/tasks`,
        { title: 'Review', assigneeId: bob.userId },
        alice.headers
      )

      await vi.waitFor(
        () =>
          expectMailSent(api.outbox, {
            to: 'bob@example.com',
            template: taskAssignedMail,
            locale: 'fr',
          }),
        { timeout: 10_000, interval: 50 }
      )
    }
  )
})
