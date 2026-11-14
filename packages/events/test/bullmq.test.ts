import { Queue, UnrecoverableError } from 'bullmq'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createEventBus,
  createWorker,
  defineListener,
  startWorker,
  type ListenerHandler,
} from '../src/index.js'
import {
  createBullmqSource,
  createBullmqTransport,
} from '../src/transports/bullmq.js'
import {
  DEFAULT_JOB_OPTIONS,
  processorOf,
} from '../src/transports/bullmq-internal.js'
import { createLogger, envelopeOf, userCreated } from './support.js'

const listenerOf = (
  name: string,
  handle: ListenerHandler<{ userId: string }>
) => defineListener(userCreated, { name, handle })

describe('BullMQ transport', () => {
  it('adds one job per message, with the default options', async () => {
    const addBulk = vi.fn(async () => [])
    const close = vi.fn(async () => {})
    const transport = createBullmqTransport({ queue: { addBulk, close } })
    const events = createEventBus({
      transport,
      listeners: [listenerOf('a', () => {}), listenerOf('b', () => {})],
    })
    const { messages } = await events.emit(userCreated, {
      userId: '42',
    })

    expect(transport.kind).toBe('bullmq')
    expect(addBulk).toHaveBeenCalledExactlyOnceWith([
      {
        name: 'a',
        data: expect.objectContaining({ id: messages[0]?.id, listener: 'a' }),
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: false,
          jobId: messages[0]?.id,
        },
      },
      expect.objectContaining({
        name: 'b',
        opts: expect.objectContaining({ jobId: messages[1]?.id }),
      }),
    ])
    await transport.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('delays jobs and merges the job options', async () => {
    const addBulk = vi.fn(async () => [])
    const transport = createBullmqTransport({
      queue: { addBulk, close: async () => {} },
      jobOptions: { attempts: 5, removeOnFail: { age: 3600 } },
    })
    await transport.send([envelopeOf()], { delay: 60 })
    await transport.send([envelopeOf()], { delay: 0 })
    expect(addBulk.mock.calls[0]).toEqual([
      [
        {
          name: 'send-welcome-mail',
          data: envelopeOf(),
          opts: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: { age: 3600 },
            jobId: envelopeOf().id,
            delay: 60_000,
          },
        },
      ],
    ])
    expect(
      (addBulk.mock.calls[1] as unknown as [{ opts: object }[]])[0][0]?.opts
    ).not.toHaveProperty('delay')
    expect(DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: false,
    })
  })

  it.each([
    [
      'not an object',
      'events',
      'createBullmqTransport(): expected an object of options.',
    ],
    [
      'an unknown option',
      { queue: 'events', connection: {}, attempts: 3 },
      'createBullmqTransport(): unknown option "attempts".',
    ],
    [
      'no name',
      { connection: {} },
      'createBullmqTransport(): queue must be a non-empty string.',
    ],
    [
      'an empty name',
      { queue: '', connection: {} },
      'createBullmqTransport(): queue must be a non-empty string.',
    ],
    [
      'no connection',
      { queue: 'events' },
      'createBullmqTransport(): connection must be Redis connection options or an ioredis instance.',
    ],
    [
      'a connection URL',
      { queue: 'events', connection: 'redis://x' },
      'createBullmqTransport(): connection must be Redis connection options or an ioredis instance.',
    ],
    [
      'a null connection',
      { queue: 'events', connection: null },
      'createBullmqTransport(): connection must be Redis connection options or an ioredis instance.',
    ],
    [
      'an empty prefix',
      { queue: 'events', connection: {}, prefix: '' },
      'createBullmqTransport(): prefix must be a non-empty string.',
    ],
    [
      'a queue with a connection',
      { queue: { addBulk() {} }, connection: {} },
      'createBullmqTransport(): a BullMQ queue takes no connection or prefix.',
    ],
    [
      'a queue with a prefix',
      { queue: { addBulk() {} }, prefix: 'p' },
      'createBullmqTransport(): a BullMQ queue takes no connection or prefix.',
    ],
    [
      'a queue without addBulk()',
      { queue: {} },
      'createBullmqTransport(): queue must be the name of a queue, or a BullMQ queue.',
    ],
    [
      'a null queue',
      { queue: null, connection: {} },
      'createBullmqTransport(): queue must be a non-empty string.',
    ],
    [
      'invalid job options',
      { queue: { addBulk() {} }, jobOptions: [] },
      'createBullmqTransport(): jobOptions must be an object.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createBullmqTransport(options as never)).toThrow(
      new TypeError(message)
    )
  })
})

describe('BullMQ processor', () => {
  const worker = createWorker({
    listeners: [
      listenerOf('ok', () => {}),
      listenerOf('failing', () => {
        throw new Error('down')
      }),
      listenerOf('throwing-text', () => {
        throw 'timeout'
      }),
    ],
  })
  const process = processorOf(worker)

  it('passes the attempt number', async () => {
    const handle = vi.fn(async () => ({ status: 'success' as const }))
    await processorOf({ listeners: [], handle })({
      data: envelopeOf({ listener: 'ok' }),
      attemptsMade: 2,
    })
    expect(handle).toHaveBeenCalledWith(envelopeOf({ listener: 'ok' }), {
      attempt: 3,
    })
  })

  it('throws to retry a failed listener', async () => {
    await expect(
      process({ data: envelopeOf({ listener: 'failing' }), attemptsMade: 0 })
    ).rejects.toThrow(new Error('down'))
    const error = await process({
      data: envelopeOf({ listener: 'throwing-text' }),
      attemptsMade: 0,
    }).catch((e: unknown) => e)
    expect(error).toEqual(new Error('timeout'))
    expect(error).not.toBeInstanceOf(UnrecoverableError)
  })

  it('fails dead messages at once', async () => {
    const error = await process({
      data: envelopeOf({ listener: 'unknown' }),
      attemptsMade: 0,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UnrecoverableError)
    expect((error as Error).message).toBe(
      'unknown-listener: Unknown listener "unknown": this worker runs ok, failing, throwing-text.'
    )
  })
})

describe('BullMQ source', () => {
  it.each([
    [
      'not an object',
      null,
      'createBullmqSource(): expected an object of options.',
    ],
    [
      'an unknown option',
      { queue: 'events', connection: {}, attempts: 3 },
      'createBullmqSource(): unknown option "attempts".',
    ],
    [
      'no name',
      { connection: {} },
      'createBullmqSource(): queue must be a non-empty string.',
    ],
    [
      'no connection',
      { queue: 'events' },
      'createBullmqSource(): connection must be Redis connection options or an ioredis instance.',
    ],
    [
      'a concurrency of 0',
      { queue: 'events', connection: {}, concurrency: 0 },
      'createBullmqSource(): concurrency must be a positive integer.',
    ],
    [
      'a concurrency that is not an integer',
      { queue: 'events', connection: {}, concurrency: 1.5 },
      'createBullmqSource(): concurrency must be a positive integer.',
    ],
    [
      'a negative close timeout',
      { queue: 'events', connection: {}, closeTimeout: -1 },
      "createBullmqSource(): closeTimeout must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.",
    ],
    [
      'a close timeout without unit',
      { queue: 'events', connection: {}, closeTimeout: '30' },
      "createBullmqSource(): closeTimeout must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.",
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createBullmqSource(options as never)).toThrow(
      new TypeError(message)
    )
  })

  it('accepts its options', () => {
    expect(
      createBullmqSource({
        queue: 'events',
        connection: {},
        prefix: 'app',
        concurrency: 4,
      }).kind
    ).toBe('bullmq')
  })
})

// Integration tests with Redis: REDIS_URL=redis://localhost:6379
const redisUrl = process.env.REDIS_URL
describe.skipIf(!redisUrl)('BullMQ with Redis', () => {
  const url = new URL(redisUrl ?? 'redis://localhost')
  const connection = {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
  }
  const prefix = `dotpress-test-${process.pid}`
  const queues: Queue[] = []
  let count = 0

  const setup = (
    listeners: ReturnType<typeof listenerOf>[],
    jobOptions = { backoff: { type: 'fixed', delay: 10 } }
  ) => {
    count += 1
    const name = `events-${count}`
    const transport = createBullmqTransport({
      queue: name,
      connection,
      prefix,
      jobOptions,
    })
    const events = createEventBus({ transport, listeners })
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners, logger, maxAttempts: 3 }),
      createBullmqSource({ queue: name, connection, prefix, concurrency: 2 }),
      { logger }
    )
    const queue = new Queue(name, { connection, prefix })
    queues.push(queue)
    return { events, transport, running, logger, queue }
  }

  afterAll(async () => {
    for (const queue of queues) {
      await queue.obliterate({ force: true })
      await queue.close()
    }
  })

  it('runs the listeners of the queue', async () => {
    const received: string[] = []
    const { events, transport, running, queue } = setup([
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
    await vi.waitFor(() => expect(received.sort()).toEqual(['a:42', 'b:42']))
    await running.stop()
    await transport.close()
    // Completed jobs are removed.
    await vi.waitFor(async () =>
      expect(await queue.getJobCounts('completed')).toEqual({ completed: 0 })
    )
  })

  it('retries failed listeners, then keeps the failed job', async () => {
    const attempts: number[] = []
    const { events, transport, running, logger, queue } = setup([
      listenerOf('flaky', ({ attempt }) => {
        attempts.push(attempt)
        throw new Error('down')
      }),
    ])
    const { messages } = await events.emit(userCreated, {
      userId: '1',
    })
    await vi.waitFor(() => expect(attempts).toEqual([1, 2, 3]))
    await vi.waitFor(async () => {
      const [failed] = await queue.getFailed()
      expect(failed?.id).toBe(messages[0]?.id)
      expect(failed?.failedReason).toBe('down')
    })
    await running.stop()
    await transport.close()
    expect(
      logger.entries.filter(({ level }) => level === 'error')
    ).toHaveLength(1)
  })

  it('fails dead messages at once', async () => {
    const { running, queue, transport } = setup([listenerOf('a', () => {})])
    await transport.send([envelopeOf({ listener: 'removed' })], {
      delay: undefined,
    })
    await vi.waitFor(async () => {
      const [failed] = await queue.getFailed()
      expect(failed?.attemptsMade).toBe(1)
      expect(failed?.failedReason).toBe(
        'unknown-listener: Unknown listener "removed": this worker runs a.'
      )
    })
    await running.stop()
    await transport.close()
  })

  it('ignores a message emitted twice, and delays messages', async () => {
    const received: string[] = []
    const { running, queue, transport } = setup([
      listenerOf('send-welcome-mail', ({ id }) => void received.push(id)),
    ])
    const envelope = envelopeOf()
    await transport.send([envelope], { delay: 1 })
    await transport.send([envelope], { delay: 1 })
    expect(await queue.getJobCounts('delayed')).toEqual({ delayed: 1 })
    await vi.waitFor(() => expect(received).toEqual([envelope.id]), {
      timeout: 3000,
    })
    await running.stop()
    await transport.close()
  })

  it('ignores an emission sent again until its job is done', async () => {
    const received: string[] = []
    const { events, running, queue, transport } = setup([
      listenerOf('a', ({ id }) => void received.push(id)),
    ])
    const options = { emissionId: 'user-created:42', delay: 1 }
    const first = await events.emit(userCreated, { userId: '42' }, options)
    const second = await events.emit(userCreated, { userId: '42' }, options)
    expect(second.messages).toEqual(first.messages)
    expect(await queue.getJobCounts('delayed')).toEqual({ delayed: 1 })
    const id = first.messages[0]?.id
    await vi.waitFor(() => expect(received).toEqual([id]), { timeout: 3000 })
    // The completed job is removed: the same message is a new job.
    await vi.waitFor(async () =>
      expect(await queue.getJobCounts('completed')).toEqual({ completed: 0 })
    )
    await events.emit(
      userCreated,
      { userId: '42' },
      { emissionId: options.emissionId }
    )
    await vi.waitFor(() => expect(received).toEqual([id, id]))
    await running.stop()
    await transport.close()
  })

  it('waits for the jobs in progress on stop', async () => {
    const steps: string[] = []
    const { events, running, transport } = setup([
      listenerOf('slow', async () => {
        steps.push('started')
        await new Promise((resolve) => setTimeout(resolve, 300))
        steps.push('finished')
      }),
    ])
    await events.emit(userCreated, { userId: '1' })
    await vi.waitFor(() => expect(steps).toEqual(['started']))
    await running.stop()
    steps.push('stopped')
    expect(steps).toEqual(['started', 'finished', 'stopped'])
    await transport.close()
  })

  it('handles jobs concurrently', async () => {
    const steps: string[] = []
    const slow = (name: string) =>
      listenerOf(name, async () => {
        steps.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, 200))
        steps.push(`${name}:end`)
      })
    // setup() uses a concurrency of 2.
    const { events, running, transport } = setup([slow('a'), slow('b')])
    await events.emit(userCreated, { userId: '1' })
    await vi.waitFor(() => expect(steps).toHaveLength(4))
    expect(steps.slice(0, 2).every((step) => step.endsWith(':start'))).toBe(
      true
    )
    await running.stop()
    await transport.close()
  })

  it('stops at once with an aborted signal', async () => {
    const running = startWorker(
      createWorker({ listeners: [] }),
      createBullmqSource({ queue: 'aborted', connection, prefix }),
      { signal: AbortSignal.abort() }
    )
    await expect(running.done).resolves.toBeUndefined()
  })

  it('logs worker errors', async () => {
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners: [] }),
      createBullmqSource({
        queue: 'unreachable',
        connection: { host: '127.0.0.1', port: 1, maxRetriesPerRequest: null },
        closeTimeout: '100ms',
      }),
      { logger }
    )
    await vi.waitFor(() =>
      expect(
        logger.entries.some(({ message }) => message === 'BullMQ worker error')
      ).toBe(true)
    )
    await running.stop()
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'BullMQ worker not closed in time: stopped without waiting',
      data: { queue: 'unreachable', closeTimeout: 100 },
    })
  })
})
