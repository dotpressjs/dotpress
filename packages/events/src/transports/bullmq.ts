import {
  Queue,
  Worker as BullWorker,
  type ConnectionOptions,
  type JobsOptions,
} from 'bullmq'
import { optionalMilliseconds, type Duration } from '../duration.js'
import { checkLogger } from '../logger.js'
import type { Source, Transport } from '../transport.js'
import { DEFAULT_JOB_OPTIONS, processorOf } from './bullmq-internal.js'

/** A BullMQ queue, or any object with the same methods. */
export interface BullmqQueue {
  addBulk(
    jobs: { name: string; data: unknown; opts?: JobsOptions }[]
  ): Promise<unknown>
  close(): Promise<void>
}

/** Options of `createBullmqTransport()`. */
export type BullmqTransportOptions = {
  /**
   * Options of the jobs, merged with the defaults: 3 attempts, exponential
   * backoff from 1 second, completed jobs removed, failed jobs kept.
   */
  jobOptions?: Omit<JobsOptions, 'jobId' | 'delay'> | undefined
} & (
  | {
      /** Name of the queue. */
      queue: string
      /** Redis connection: ioredis options or instance. */
      connection: ConnectionOptions
      /** Prefix of the Redis keys (instead of the ioredis `keyPrefix`). */
      prefix?: string | undefined
    }
  | {
      /** Existing queue (another backend, shared connection…). */
      queue: BullmqQueue
      connection?: never
      prefix?: never
    }
)

/** BullMQ transport: close it to release its Redis connection. */
export interface BullmqTransport extends Transport {
  close(): Promise<void>
}

/** Options of `createBullmqSource()`. */
export interface BullmqSourceOptions {
  /** Name of the queue. */
  queue: string
  /** Redis connection: ioredis options or instance. */
  connection: ConnectionOptions
  /** Prefix of the Redis keys, as in the transport. */
  prefix?: string | undefined
  /** Messages handled at the same time. Defaults to 1. */
  concurrency?: number | undefined
  /**
   * On stop, how long to wait for the jobs in progress before stopping
   * anyway (their jobs become stalled and are retried by another worker).
   * Defaults to 30 seconds. Also bounds the stop when Redis is unreachable.
   */
  closeTimeout?: Duration | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const checkOptions = (
  label: string,
  options: unknown,
  allowed: readonly string[]
): Record<string, unknown> => {
  if (!isRecord(options)) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  return options
}

const checkQueue = (label: string, values: Record<string, unknown>) => {
  if (typeof values.queue !== 'string' || values.queue === '') {
    throw new TypeError(`${label}: queue must be a non-empty string.`)
  }
  if (typeof values.connection !== 'object' || values.connection === null) {
    throw new TypeError(
      `${label}: connection must be Redis connection options or an ioredis instance.`
    )
  }
  if (
    values.prefix !== undefined &&
    (typeof values.prefix !== 'string' || values.prefix === '')
  ) {
    throw new TypeError(`${label}: prefix must be a non-empty string.`)
  }
}

/**
 * Creates a transport that adds messages as jobs to a BullMQ queue
 * (`bullmq`, peer dependency; Redis by default). The job name is the
 * listener, its id the message id: emitting again adds no duplicate.
 *
 * ```ts
 * const transport = createBullmqTransport({
 *   queue: 'events',
 *   connection: { host: 'localhost', port: 6379 },
 * })
 * ```
 */
export const createBullmqTransport = (
  options: BullmqTransportOptions
): BullmqTransport => {
  const label = 'createBullmqTransport()'
  const values = checkOptions(label, options, [
    'queue',
    'connection',
    'prefix',
    'jobOptions',
  ])
  let queue: BullmqQueue
  if (typeof values.queue === 'object' && values.queue !== null) {
    if (values.connection !== undefined || values.prefix !== undefined) {
      throw new TypeError(
        `${label}: a BullMQ queue takes no connection or prefix.`
      )
    }
    if (typeof (values.queue as BullmqQueue).addBulk !== 'function') {
      throw new TypeError(
        `${label}: queue must be the name of a queue, or a BullMQ queue.`
      )
    }
    queue = values.queue as BullmqQueue
  } else {
    checkQueue(label, values)
    queue = new Queue(values.queue as string, {
      connection: values.connection as ConnectionOptions,
      ...(values.prefix === undefined
        ? {}
        : { prefix: values.prefix as string }),
    })
  }
  if (values.jobOptions !== undefined && !isRecord(values.jobOptions)) {
    throw new TypeError(`${label}: jobOptions must be an object.`)
  }
  const jobOptions = { ...DEFAULT_JOB_OPTIONS, ...(values.jobOptions ?? {}) }

  return {
    kind: 'bullmq',
    send: async (envelopes, { delay }) => {
      await queue.addBulk(
        envelopes.map((envelope) => ({
          name: envelope.listener,
          data: envelope,
          opts: {
            ...jobOptions,
            // Duplicates of an existing job are ignored.
            jobId: envelope.id,
            ...(delay ? { delay: delay * 1000 } : {}),
          },
        }))
      )
    },
    close: () => queue.close(),
  }
}

/**
 * Creates a source that runs a BullMQ worker on the queue, for
 * `startWorker()` and `dotpress-events work` (Node.js and Bun).
 *
 * ```ts
 * export default {
 *   worker: createWorker({ listeners, maxAttempts: 3 }),
 *   source: createBullmqSource({ queue: 'events', connection, concurrency: 5 }),
 * }
 * ```
 */
export const createBullmqSource = (options: BullmqSourceOptions): Source => {
  const label = 'createBullmqSource()'
  const values = checkOptions(label, options, [
    'queue',
    'connection',
    'prefix',
    'concurrency',
    'closeTimeout',
  ])
  checkQueue(label, values)
  const { concurrency = 1 } = values
  if (!Number.isInteger(concurrency) || (concurrency as number) < 1) {
    throw new TypeError(`${label}: concurrency must be a positive integer.`)
  }
  const closeTimeout = optionalMilliseconds(
    values.closeTimeout,
    `${label}: closeTimeout`,
    30_000
  )

  return {
    kind: 'bullmq',
    consume: async (worker, { signal, logger }) => {
      checkLogger(label, logger)
      const bullWorker = new BullWorker(
        values.queue as string,
        processorOf(worker),
        {
          connection: values.connection as ConnectionOptions,
          concurrency: concurrency as number,
          ...(values.prefix === undefined
            ? {}
            : { prefix: values.prefix as string }),
        }
      )
      // Without a listener, an error may stop the worker.
      bullWorker.on('error', (error) => {
        logger.error(
          { queue: values.queue, error: error.message },
          'BullMQ worker error'
        )
      })
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      // Waits for the jobs in progress, within closeTimeout: BullMQ never
      // closes gracefully while Redis is unreachable.
      let timer: ReturnType<typeof setTimeout> | undefined
      const closed = await Promise.race([
        bullWorker.close().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), closeTimeout)
        }),
      ])
      clearTimeout(timer)
      if (!closed) {
        // close() never resolves while Redis is unreachable, and a forced
        // close() returns the same pending promise: give up waiting.
        // BullMQ may keep reconnecting until the process exits.
        logger.warn(
          { queue: values.queue, closeTimeout },
          'BullMQ worker not closed in time: stopped without waiting'
        )
      }
    },
  }
}
