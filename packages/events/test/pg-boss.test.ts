import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createEventBus,
  createWorker,
  defineListener,
  startWorker,
  type ListenerHandler,
} from '../src/index.js'
import {
  createPgBossSource,
  createPgBossTransport,
} from '../src/transports/pg-boss.js'
import {
  DEFAULT_QUEUE_OPTIONS,
  handlerOf,
} from '../src/transports/pg-boss-internal.js'
import { createLogger, envelopeOf, userCreated } from './support.js'

const listenerOf = (
  name: string,
  handle: ListenerHandler<{ userId: string }>
) => defineListener(userCreated, { name, handle })

/** A pg-boss instance recording its calls. */
const fakeBoss = (queues: Record<string, { deadLetter?: string }> = {}) => ({
  insert: vi.fn(async () => []),
  work: vi.fn<
    (name: string, options: object, handler: unknown) => Promise<string>
  >(async () => 'worker-id'),
  offWork: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  getQueue: vi.fn(async (name: string) => queues[name] ?? null),
  createQueue: vi.fn(
    async (name: string, options: { deadLetter?: string } = {}) => {
      queues[name] = options
    }
  ),
  on: vi.fn(),
  off: vi.fn(),
})

describe('pg-boss transport', () => {
  it('creates the queue with the defaults, then inserts one job per message', async () => {
    const boss = fakeBoss()
    const transport = createPgBossTransport({
      boss: boss as never,
      queue: 'events',
    })
    const events = createEventBus({
      transport,
      listeners: [listenerOf('a', () => {}), listenerOf('b', () => {})],
    })
    const { messages } = await events.emit(userCreated, {
      userId: '42',
    })
    await events.emit(userCreated, { userId: '43' }, { delay: 60 })

    expect(transport.kind).toBe('pg-boss')
    expect(boss.start).not.toHaveBeenCalled()
    expect(boss.createQueue).toHaveBeenCalledExactlyOnceWith('events', {
      retryLimit: 2,
      retryDelay: 1,
      retryBackoff: true,
    })
    expect(boss.insert.mock.calls[0]).toEqual([
      'events',
      [
        {
          id: messages[0]?.id,
          data: expect.objectContaining({ listener: 'a' }),
        },
        {
          id: messages[1]?.id,
          data: expect.objectContaining({ listener: 'b' }),
        },
      ],
    ])
    expect(
      (boss.insert.mock.calls[1] as unknown as [string, object[]])[1][0]
    ).toMatchObject({
      startAfter: 60,
    })
    // A provided instance is not stopped.
    await transport.close()
    expect(boss.stop).not.toHaveBeenCalled()
    expect(DEFAULT_QUEUE_OPTIONS).toEqual({
      retryLimit: 2,
      retryDelay: 1,
      retryBackoff: true,
    })
  })

  it('creates the dead-letter queue, and keeps existing queues', async () => {
    const boss = fakeBoss()
    const transport = createPgBossTransport({
      boss: boss as never,
      queue: 'events',
      queueOptions: { retryLimit: 5, deadLetter: 'events-dlq' },
    })
    await transport.send([envelopeOf()], { delay: 0 })
    expect(boss.createQueue.mock.calls).toEqual([
      ['events-dlq'],
      [
        'events',
        {
          retryLimit: 5,
          retryDelay: 1,
          retryBackoff: true,
          deadLetter: 'events-dlq',
        },
      ],
    ])
    expect(
      (boss.insert.mock.calls[0] as unknown as [string, object[]])[1][0]
    ).not.toHaveProperty('startAfter')

    const existing = fakeBoss({ events: {}, 'events-dlq': {} })
    await createPgBossTransport({
      boss: existing as never,
      queue: 'events',
      queueOptions: { deadLetter: 'events-dlq' },
    }).send([envelopeOf()], { delay: undefined })
    expect(existing.createQueue).not.toHaveBeenCalled()
  })

  it('prepares again after a failure', async () => {
    const boss = fakeBoss()
    boss.getQueue.mockRejectedValueOnce(new Error('connection refused'))
    const transport = createPgBossTransport({
      boss: boss as never,
      queue: 'events',
    })
    await expect(
      transport.send([envelopeOf()], { delay: undefined })
    ).rejects.toThrow('connection refused')
    await transport.send([envelopeOf()], { delay: undefined })
    await transport.send([envelopeOf()], { delay: undefined })
    expect(boss.getQueue).toHaveBeenCalledTimes(2)
    expect(boss.insert).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      'not an object',
      'x',
      'createPgBossTransport(): expected an object of options.',
    ],
    [
      'an unknown option',
      { boss: 'postgres://x', queue: 'q', schema: 's' },
      'createPgBossTransport(): unknown option "schema".',
    ],
    [
      'no queue',
      { boss: 'postgres://x' },
      'createPgBossTransport(): queue must be a non-empty string.',
    ],
    [
      'an empty queue',
      { boss: 'postgres://x', queue: '' },
      'createPgBossTransport(): queue must be a non-empty string.',
    ],
    [
      'invalid queue options',
      { boss: 'postgres://x', queue: 'q', queueOptions: 3 },
      'createPgBossTransport(): queueOptions must be an object.',
    ],
    [
      'no boss',
      { queue: 'q' },
      'createPgBossTransport(): boss must be a pg-boss instance, a connection string, or pg-boss options.',
    ],
    [
      'a boss that is a number',
      { boss: 1, queue: 'q' },
      'createPgBossTransport(): boss must be a pg-boss instance, a connection string, or pg-boss options.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createPgBossTransport(options as never)).toThrow(
      new TypeError(message)
    )
  })
})

describe('pg-boss job handler', () => {
  const worker = createWorker({
    listeners: [
      listenerOf('ok', () => {}),
      listenerOf('failing', () => {
        throw new Error('down')
      }),
    ],
  })
  const job = (listener: string, retryCount = 0) => ({
    id: `job-${listener}`,
    data: envelopeOf({ listener }),
    retryCount,
  })

  it('gives a result per job', async () => {
    const attempts: number[] = []
    const counting = createWorker({
      listeners: [
        listenerOf('ok', ({ attempt }) => void attempts.push(attempt)),
      ],
    })
    expect(
      await handlerOf(counting, () => undefined)([job('ok', 2) as never])
    ).toEqual([{ id: 'job-ok', status: 'completed' }])
    expect(attempts).toEqual([3])

    const handle = handlerOf(worker, () => 'events-dlq')
    expect(await handle([job('failing'), job('unknown')] as never)).toEqual([
      {
        id: 'job-failing',
        status: 'failed',
        output: { reason: 'listener-error', error: 'down' },
      },
      {
        id: 'job-unknown',
        status: 'deadletter',
        output: {
          reason: 'unknown-listener',
          error: 'Unknown listener "unknown": this worker runs ok, failing.',
        },
      },
    ])
  })

  it('fails dead messages without dead-letter queue', async () => {
    expect(
      await handlerOf(worker, () => undefined)([job('unknown')] as never)
    ).toEqual([expect.objectContaining({ status: 'failed' })])
  })

  it('describes failures that are not errors', async () => {
    const throwing = createWorker({
      listeners: [
        listenerOf('text', () => {
          throw 'timeout'
        }),
      ],
    })
    expect(
      await handlerOf(throwing, () => undefined)([job('text')] as never)
    ).toEqual([
      {
        id: 'job-text',
        status: 'failed',
        output: { reason: 'listener-error', error: 'timeout' },
      },
    ])
  })
})

describe('pg-boss source', () => {
  it('works on the queue, then stops it', async () => {
    const boss = fakeBoss()
    const controller = new AbortController()
    const source = createPgBossSource({
      boss: boss as never,
      queue: 'events',
      concurrency: 5,
      pollInterval: 0.5,
    })
    const running = startWorker(createWorker({ listeners: [] }), source, {
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(boss.work).toHaveBeenCalled())
    expect(boss.work.mock.calls[0]).toEqual([
      'events',
      { batchSize: 5, perJobResults: true, pollingIntervalSeconds: 0.5 },
      expect.any(Function),
    ])
    controller.abort()
    await running.done
    expect(boss.offWork).toHaveBeenCalledExactlyOnceWith('events', {
      wait: true,
    })
    expect(boss.stop).not.toHaveBeenCalled()
    expect(boss.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(boss.off).toHaveBeenCalledWith('error', boss.on.mock.calls[0]?.[1])
  })

  it('uses the dead-letter queue of an existing queue', async () => {
    const boss = fakeBoss({ events: { deadLetter: 'events-dlq' } })
    const running = startWorker(
      createWorker({ listeners: [] }),
      createPgBossSource({ boss: boss as never, queue: 'events' })
    )
    await vi.waitFor(() => expect(boss.work).toHaveBeenCalled())
    const handler = boss.work.mock.calls[0]?.[2] as (
      jobs: object[]
    ) => Promise<object[]>
    expect(
      await handler([
        { id: 'j1', data: envelopeOf({ listener: 'removed' }), retryCount: 0 },
      ])
    ).toEqual([expect.objectContaining({ id: 'j1', status: 'deadletter' })])
    await running.stop()
  })

  it('waits for the jobs in progress by default', async () => {
    const boss = fakeBoss()
    boss.offWork.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    )
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners: [] }),
      createPgBossSource({ boss: boss as never, queue: 'events' }),
      { logger }
    )
    await vi.waitFor(() => expect(boss.work).toHaveBeenCalled())
    await running.stop()
    expect(logger.entries.filter(({ level }) => level === 'warn')).toEqual([])
  })

  it('logs pg-boss errors', async () => {
    const boss = fakeBoss()
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners: [] }),
      createPgBossSource({ boss: boss as never, queue: 'events' }),
      { logger }
    )
    await vi.waitFor(() => expect(boss.on).toHaveBeenCalled())
    const onError = boss.on.mock.calls[0]?.[1] as (error: Error) => void
    onError(new Error('connection lost'))
    await running.stop()
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'pg-boss error',
      data: { queue: 'events', error: 'connection lost' },
    })
    expect(boss.work.mock.calls[0]?.[1]).toEqual({
      batchSize: 1,
      perJobResults: true,
    })
  })

  it('stops without waiting after closeTimeout', async () => {
    const boss = fakeBoss()
    boss.offWork.mockImplementation(() => new Promise(() => {}))
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners: [] }),
      createPgBossSource({
        boss: boss as never,
        queue: 'events',
        closeTimeout: '50ms',
      }),
      { logger }
    )
    await vi.waitFor(() => expect(boss.work).toHaveBeenCalled())
    await running.stop()
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'pg-boss worker not stopped in time: stopped without waiting',
      data: { queue: 'events', closeTimeout: 50 },
    })
  })

  it('fails to start when the queue cannot be prepared', async () => {
    const boss = fakeBoss()
    boss.getQueue.mockRejectedValue(new Error('connection refused'))
    const running = startWorker(
      createWorker({ listeners: [] }),
      createPgBossSource({ boss: boss as never, queue: 'events' })
    )
    await expect(running.done).rejects.toThrow('connection refused')
    expect(boss.off).toHaveBeenCalled()
  })

  it.each([
    [
      'an unknown option',
      { boss: 'postgres://x', queue: 'q', batchSize: 2 },
      'createPgBossSource(): unknown option "batchSize".',
    ],
    [
      'a batch of 0',
      { boss: 'postgres://x', queue: 'q', concurrency: 0 },
      'createPgBossSource(): concurrency must be a positive integer.',
    ],
    [
      'a batch size that is not an integer',
      { boss: 'postgres://x', queue: 'q', concurrency: 1.5 },
      'createPgBossSource(): concurrency must be a positive integer.',
    ],
    [
      'a polling interval under 0.5',
      { boss: 'postgres://x', queue: 'q', pollInterval: '400ms' },
      'createPgBossSource(): pollInterval must be at least 0.5 seconds.',
    ],
    [
      'a polling interval that is not a number',
      { boss: 'postgres://x', queue: 'q', pollInterval: '2' },
      "createPgBossSource(): pollInterval must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.",
    ],
    [
      'a NaN polling interval',
      { boss: 'postgres://x', queue: 'q', pollInterval: Number.NaN },
      "createPgBossSource(): pollInterval must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.",
    ],
    [
      'a negative close timeout',
      { boss: 'postgres://x', queue: 'q', closeTimeout: -1 },
      "createPgBossSource(): closeTimeout must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.",
    ],
    [
      'a close timeout without unit',
      { boss: 'postgres://x', queue: 'q', closeTimeout: '30' },
      "createPgBossSource(): closeTimeout must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.",
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createPgBossSource(options as never)).toThrow(
      new TypeError(message)
    )
  })
})

// Integration tests with Postgres: DATABASE_URL=postgres://…
const databaseUrl = process.env.DATABASE_URL
describe.skipIf(!databaseUrl)('pg-boss with Postgres', () => {
  const schema = `dotpress_test_${process.pid}`
  let admin: PgBoss
  let count = 0

  beforeAll(async () => {
    admin = new PgBoss({ connectionString: databaseUrl, schema })
    admin.on('error', () => {})
    await admin.start()
  })

  afterAll(async () => {
    await admin.stop({ graceful: false })
  })

  const setup = (
    listeners: ReturnType<typeof listenerOf>[],
    queueOptions: Record<string, unknown> = {
      retryDelay: 0,
      retryBackoff: false,
    }
  ) => {
    count += 1
    const queue = `events-${count}`
    const boss = { connectionString: databaseUrl as string, schema }
    const transport = createPgBossTransport({ boss, queue, queueOptions })
    const events = createEventBus({ transport, listeners })
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners, logger, maxAttempts: 3 }),
      createPgBossSource({
        boss,
        queue,
        queueOptions,
        pollInterval: 0.5,
        concurrency: 5,
      }),
      { logger }
    )
    return { queue, transport, events, running, logger }
  }

  it('runs the listeners of the queue', async () => {
    const received: string[] = []
    const { events, transport, running } = setup([
      listenerOf(
        'a',
        ({ payload }) => void received.push(`a:${payload.userId}`)
      ),
      listenerOf(
        'b',
        ({ payload }) => void received.push(`b:${payload.userId}`)
      ),
    ])
    await events.emit(userCreated, { userId: '42' })
    await vi.waitFor(() => expect(received.sort()).toEqual(['a:42', 'b:42']), {
      timeout: 5000,
    })
    await running.stop()
    await transport.close()
  })

  it('retries failed listeners, then moves them to the dead-letter queue', async () => {
    const attempts: number[] = []
    const { events, transport, running, queue } = setup(
      [
        listenerOf('flaky', ({ attempt }) => {
          attempts.push(attempt)
          throw new Error('down')
        }),
      ],
      { retryDelay: 0, retryBackoff: false, deadLetter: `dlq-${count + 1}` }
    )
    const { messages } = await events.emit(userCreated, {
      userId: '1',
    })
    await vi.waitFor(() => expect(attempts).toEqual([1, 2, 3]), {
      timeout: 10_000,
    })
    await vi.waitFor(
      async () => {
        const job = await admin.getJobById(queue, messages[0]?.id as string)
        expect(job?.state).toBe('failed')
        expect(job?.output).toEqual({ reason: 'listener-error', error: 'down' })
      },
      { timeout: 5000 }
    )
    const dlq = (await admin.getQueue(`dlq-${count}`)) as {
      queuedCount?: number
    } | null
    expect(dlq).not.toBeNull()
    await vi.waitFor(async () => {
      const [dead] = await admin.fetch(`dlq-${count}`)
      expect(dead?.data).toMatchObject({ id: messages[0]?.id })
    })
    await running.stop()
    await transport.close()
  }, 20_000)

  it('moves dead messages to the dead-letter queue at once', async () => {
    const { transport, running, queue } = setup([listenerOf('a', () => {})], {
      retryDelay: 0,
      deadLetter: `dlq-${count + 1}`,
    })
    const envelope = envelopeOf({ listener: 'removed' })
    await transport.send([envelope], { delay: undefined })
    await vi.waitFor(
      async () => {
        const job = await admin.getJobById(queue, envelope.id)
        expect(job?.state).toBe('failed')
        expect(job?.retryCount).toBe(0)
      },
      { timeout: 5000 }
    )
    await vi.waitFor(async () => {
      const [dead] = await admin.fetch(`dlq-${count}`)
      expect(dead?.data).toMatchObject({ id: envelope.id })
    })
    await running.stop()
    await transport.close()
  }, 15_000)

  it('delays messages', async () => {
    const received: number[] = []
    const { transport, running, queue } = setup([
      listenerOf('send-welcome-mail', () => void received.push(Date.now())),
    ])
    const start = Date.now()
    await transport.send([envelopeOf()], { delay: 2 })
    const job = await admin.getJobById(queue, envelopeOf().id)
    expect(job?.startAfter.getTime()).toBeGreaterThanOrEqual(start + 1500)
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 6000 })
    expect((received[0] as number) - start).toBeGreaterThanOrEqual(1500)
    await running.stop()
    await transport.close()
  }, 15_000)

  it('ignores a message emitted twice', async () => {
    const received: unknown[] = []
    const { transport, running, queue } = setup([
      listenerOf(
        'send-welcome-mail',
        ({ payload }) => void received.push(payload)
      ),
    ])
    await transport.send([envelopeOf({ payload: { userId: '1' } })], {
      delay: 1,
    })
    // Same id: ignored by pg-boss, the first job is kept.
    await transport.send([envelopeOf({ payload: { userId: '2' } })], {
      delay: 1,
    })
    const job = await admin.getJobById(queue, envelopeOf().id)
    expect(job?.data).toMatchObject({ payload: { userId: '1' } })
    await vi.waitFor(() => expect(received).toEqual([{ userId: '1' }]), {
      timeout: 6000,
    })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(received).toHaveLength(1)
    await running.stop()
    await transport.close()
  }, 15_000)
})
