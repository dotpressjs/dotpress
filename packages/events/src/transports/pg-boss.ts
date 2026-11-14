// pg-boss runs on Node.js and Bun: PgBoss extends the EventEmitter of Node.js.
/// <reference types="node" />
import {
  PgBoss,
  type ConstructorOptions,
  type JobInsert,
  type QueueOptions,
} from 'pg-boss'
import {
  optionalMilliseconds,
  toMilliseconds,
  type Duration,
} from '../duration.js'
import type { Envelope } from '../envelope.js'
import type { EventsLogger } from '../logger.js'
import type { Source, Transport } from '../transport.js'
import { DEFAULT_QUEUE_OPTIONS, handlerOf } from './pg-boss-internal.js'

/** Options of the queue, used when the transport or the source creates it. */
export interface PgBossQueueOptions extends QueueOptions {
  /**
   * Queue of the failed jobs (created too): jobs go there after their last
   * attempt, and messages that can never be handled at once.
   */
  deadLetter?: string | undefined
}

/** Options shared by the transport and the source. */
export interface PgBossOptions {
  /**
   * A pg-boss instance (started by you), or the options to create one: a
   * connection string, or the options of `new PgBoss()`.
   */
  boss: PgBoss | string | ConstructorOptions
  /** Name of the queue. */
  queue: string
  /**
   * Options of the queue when it does not exist yet, merged with the
   * defaults: 3 attempts (`retryLimit: 2`), exponential backoff from 1
   * second. Existing queues are not changed.
   */
  queueOptions?: PgBossQueueOptions | undefined
}

/** Options of `createPgBossSource()`. */
export interface PgBossSourceOptions extends PgBossOptions {
  /** Jobs fetched at once, handled in parallel. Defaults to 1. */
  concurrency?: number | undefined
  /**
   * Wait between two fetches of an empty queue, at least half a second.
   * Defaults to the one of pg-boss (2 seconds).
   */
  pollInterval?: Duration | undefined
  /**
   * On stop, how long to wait for the jobs in progress before stopping
   * anyway. Defaults to 30 seconds.
   */
  closeTimeout?: Duration | undefined
}

/** pg-boss transport: close it to stop the instance it created. */
export interface PgBossTransport extends Transport {
  /** Stops the pg-boss instance, if the transport created it. */
  close(): Promise<void>
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

const isBoss = (value: unknown): value is PgBoss =>
  typeof (value as PgBoss | null)?.insert === 'function'

/** The pg-boss instance of the options, started and with its queue. */
const bossOf = (label: string, values: Record<string, unknown>) => {
  const { boss, queue, queueOptions } = values
  if (typeof queue !== 'string' || queue === '') {
    throw new TypeError(`${label}: queue must be a non-empty string.`)
  }
  if (queueOptions !== undefined && !isRecord(queueOptions)) {
    throw new TypeError(`${label}: queueOptions must be an object.`)
  }
  const owned = !isBoss(boss)
  if (owned && typeof boss !== 'string' && !isRecord(boss)) {
    throw new TypeError(
      `${label}: boss must be a pg-boss instance, a connection string, or pg-boss options.`
    )
  }
  const instance = !owned
    ? (boss as PgBoss)
    : typeof boss === 'string'
      ? new PgBoss(boss)
      : new PgBoss(boss as ConstructorOptions)
  const { deadLetter, ...options } = {
    ...DEFAULT_QUEUE_OPTIONS,
    ...((queueOptions as PgBossQueueOptions | undefined) ?? {}),
  }

  let ready: Promise<{ deadLetter: string | undefined }> | undefined
  /** Starts the instance (if owned) and creates the queues, once. */
  const prepare = () =>
    (ready ??= (async () => {
      if (owned) await instance.start()
      if (deadLetter && !(await instance.getQueue(deadLetter))) {
        await instance.createQueue(deadLetter)
      }
      const existing = await instance.getQueue(queue)
      if (!existing) {
        await instance.createQueue(queue, {
          ...options,
          ...(deadLetter ? { deadLetter } : {}),
        })
        return { deadLetter }
      }
      return { deadLetter: existing.deadLetter ?? undefined }
    })().catch((error: unknown) => {
      // Tried again on the next use.
      ready = undefined
      throw error
    }))

  return { instance, owned, queue, prepare }
}

/**
 * Creates a transport that inserts messages as jobs in a pg-boss queue
 * (`pg-boss`, peer dependency): Postgres as the queue, no other
 * infrastructure. The job id is the message id.
 *
 * ```ts
 * const transport = createPgBossTransport({
 *   boss: process.env.DATABASE_URL!,
 *   queue: 'events',
 * })
 * ```
 */
export const createPgBossTransport = (
  options: PgBossOptions
): PgBossTransport => {
  const label = 'createPgBossTransport()'
  const values = checkOptions(label, options, ['boss', 'queue', 'queueOptions'])
  const { instance, owned, queue, prepare } = bossOf(label, values)

  return {
    kind: 'pg-boss',
    send: async (envelopes, { delay }) => {
      await prepare()
      await instance.insert(
        queue,
        envelopes.map((envelope): JobInsert<Envelope> => ({
          id: envelope.id,
          data: envelope,
          ...(delay ? { startAfter: delay } : {}),
        }))
      )
    },
    close: async () => {
      if (owned) await instance.stop({ graceful: true })
    },
  }
}

/**
 * Creates a source that works on the pg-boss queue, for `startWorker()` and
 * `dotpress-events work` (Node.js and Bun).
 *
 * ```ts
 * export default {
 *   worker: createWorker({ listeners, maxAttempts: 3 }),
 *   source: createPgBossSource({ boss: process.env.DATABASE_URL!, queue: 'events' }),
 * }
 * ```
 */
export const createPgBossSource = (options: PgBossSourceOptions): Source => {
  const label = 'createPgBossSource()'
  const values = checkOptions(label, options, [
    'boss',
    'queue',
    'queueOptions',
    'concurrency',
    'pollInterval',
    'closeTimeout',
  ])
  const { instance, owned, queue, prepare } = bossOf(label, values)
  const batchSize = values.concurrency ?? 1
  if (!Number.isInteger(batchSize) || (batchSize as number) < 1) {
    throw new TypeError(`${label}: concurrency must be a positive integer.`)
  }
  const pollingIntervalSeconds =
    values.pollInterval === undefined
      ? undefined
      : toMilliseconds(values.pollInterval, `${label}: pollInterval`) / 1000
  if (pollingIntervalSeconds !== undefined && pollingIntervalSeconds < 0.5) {
    throw new TypeError(`${label}: pollInterval must be at least 0.5 seconds.`)
  }
  const closeTimeout = optionalMilliseconds(
    values.closeTimeout,
    `${label}: closeTimeout`,
    30_000
  )

  return {
    kind: 'pg-boss',
    consume: async (worker, { signal, logger }) => {
      const onError = (error: Error) => {
        logger.error({ queue, error: error.message }, 'pg-boss error')
      }
      // Without a listener, an error event would crash the process.
      instance.on('error', onError)
      try {
        const { deadLetter } = await prepare()
        await instance.work<Envelope>(
          queue,
          {
            batchSize: batchSize as number,
            perJobResults: true,
            ...(pollingIntervalSeconds === undefined
              ? {}
              : { pollingIntervalSeconds }),
          },
          handlerOf(worker, () => deadLetter)
        )
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        await stopWithin(
          async () => {
            await instance.offWork(queue, { wait: true })
            if (owned) await instance.stop({ graceful: true })
          },
          closeTimeout,
          logger,
          queue
        )
      } finally {
        instance.off('error', onError)
      }
    },
  }
}

/** Runs `stop`, giving up after `timeout` milliseconds. */
const stopWithin = async (
  stop: () => Promise<void>,
  timeout: number,
  logger: EventsLogger,
  queue: string
) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = await Promise.race([
    stop().then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeout)
    }),
  ])
  clearTimeout(timer)
  if (!stopped) {
    logger.warn(
      { queue, closeTimeout: timeout },
      'pg-boss worker not stopped in time: stopped without waiting'
    )
  }
}
