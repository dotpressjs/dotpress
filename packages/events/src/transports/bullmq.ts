import {
  Queue,
  UnrecoverableError,
  Worker as BullWorker,
  type ConnectionOptions,
  type Job,
  type JobsOptions,
} from 'bullmq'
import type { Envelope } from '../envelope.js'
import { checkLogger } from '../logger.js'
import type { Source, Transport } from '../transport.js'
import type { Worker } from '../worker.js'

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
      name: string
      /** Redis connection: ioredis options or instance. */
      connection: ConnectionOptions
      /** Prefix of the Redis keys (instead of the ioredis `keyPrefix`). */
      prefix?: string | undefined
      queue?: never
    }
  | {
      /** Existing queue (another backend, shared connection…). */
      queue: BullmqQueue
      name?: never
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
  name: string
  /** Redis connection: ioredis options or instance. */
  connection: ConnectionOptions
  /** Prefix of the Redis keys, as in the transport. */
  prefix?: string | undefined
  /** Messages handled at the same time. Defaults to 1. */
  concurrency?: number | undefined
  /**
   * On stop, how long to wait for the jobs in progress, in milliseconds,
   * before stopping anyway (their jobs become stalled and are retried by
   * another worker). Defaults to 30 seconds. Also bounds the stop when
   * Redis is unreachable.
   */
  closeTimeout?: number | undefined
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: false,
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
  if (typeof values.name !== 'string' || values.name === '') {
    throw new TypeError(`${label}: name must be a non-empty string.`)
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
 *   name: 'events',
 *   connection: { host: 'localhost', port: 6379 },
 * })
 * ```
 */
export const createBullmqTransport = (
  options: BullmqTransportOptions
): BullmqTransport => {
  const label = 'createBullmqTransport()'
  const values = checkOptions(label, options, [
    'name',
    'connection',
    'prefix',
    'queue',
    'jobOptions',
  ])
  let queue: BullmqQueue
  if (values.queue !== undefined) {
    if (
      values.name !== undefined ||
      values.connection !== undefined ||
      values.prefix !== undefined
    ) {
      throw new TypeError(
        `${label}: set queue, or name and connection, not both.`
      )
    }
    if (typeof (values.queue as BullmqQueue | null)?.addBulk !== 'function') {
      throw new TypeError(`${label}: queue must be a BullMQ queue.`)
    }
    queue = values.queue as BullmqQueue
  } else {
    checkQueue(label, values)
    queue = new Queue(values.name as string, {
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

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error))

/**
 * Processor of BullMQ jobs: a failed listener throws (retried within the
 * `attempts` of the job), a message that can never be handled throws an
 * `UnrecoverableError` (failed at once).
 */
export const processorOf =
  (worker: Worker) =>
  async (job: Pick<Job<Envelope>, 'data' | 'attemptsMade'>) => {
    const result = await worker.handle(job.data, {
      attempt: job.attemptsMade + 1,
    })
    if (result.status === 'retry') throw toError(result.error)
    if (result.status === 'dead') {
      throw new UnrecoverableError(
        `${result.reason}: ${toError(result.error).message}`
      )
    }
  }

/**
 * Creates a source that runs a BullMQ worker on the queue, for
 * `startWorker()` and `dotpress-events work` (Node.js and Bun).
 *
 * ```ts
 * export default {
 *   worker: createWorker({ listeners, maxAttempts: 3 }),
 *   source: createBullmqSource({ name: 'events', connection, concurrency: 5 }),
 * }
 * ```
 */
export const createBullmqSource = (options: BullmqSourceOptions): Source => {
  const label = 'createBullmqSource()'
  const values = checkOptions(label, options, [
    'name',
    'connection',
    'prefix',
    'concurrency',
    'closeTimeout',
  ])
  checkQueue(label, values)
  const { concurrency = 1, closeTimeout = 30_000 } = values
  if (!Number.isInteger(concurrency) || (concurrency as number) < 1) {
    throw new TypeError(`${label}: concurrency must be a positive integer.`)
  }
  if (!Number.isInteger(closeTimeout) || (closeTimeout as number) < 0) {
    throw new TypeError(
      `${label}: closeTimeout must be a non-negative integer (milliseconds).`
    )
  }

  return {
    kind: 'bullmq',
    consume: async (worker, { signal, logger }) => {
      checkLogger(label, logger)
      const bullWorker = new BullWorker(
        values.name as string,
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
          { queue: values.name, error: error.message },
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
          timer = setTimeout(() => resolve(false), closeTimeout as number)
        }),
      ])
      clearTimeout(timer)
      if (!closed) {
        // close() never resolves while Redis is unreachable, and a forced
        // close() returns the same pending promise: give up waiting.
        // BullMQ may keep reconnecting until the process exits.
        logger.warn(
          { queue: values.name, closeTimeout },
          'BullMQ worker not closed in time: stopped without waiting'
        )
      }
    },
  }
}
