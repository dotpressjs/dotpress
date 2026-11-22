import { checkLogger, consoleLogger, type EventsLogger } from './logger.js'
import type { Source } from './transport.js'
import type { Worker } from './worker.js'

/**
 * What the module given to `dotpress-events work` exports: the worker, the
 * source it reads, and optionally a logger.
 *
 * ```ts
 * export const worker = createWorker({ listeners })
 * export const source = createSqsSource({ queueUrl })
 * ```
 */
export interface WorkerEntry {
  worker: Worker
  source: Source
  logger?: EventsLogger | undefined
}

/** A started worker. */
export interface RunningWorker {
  /** Stops reading messages, waits for those in progress, then resolves. */
  stop(): Promise<void>
  /** Resolves when the worker has stopped; rejects if the source failed. */
  readonly done: Promise<void>
}

/** Options of `startWorker()`. */
export interface StartWorkerOptions {
  logger?: EventsLogger | undefined
  /** Stops the worker when aborted. */
  signal?: AbortSignal | undefined
}

/**
 * Starts a long-running worker: the source reads messages from its queue
 * (SQS polling, BullMQ, pg-boss…) and the worker runs their listeners,
 * until `stop()`. Used by containers and by `dotpress-events work`.
 */
export const startWorker = (
  worker: Worker,
  source: Source,
  options: StartWorkerOptions = {}
): RunningWorker => {
  const label = 'startWorker()'
  if (typeof worker?.handle !== 'function') {
    throw new TypeError(
      `${label}: expected a worker created by createWorker().`
    )
  }
  if (typeof source?.consume !== 'function') {
    throw new TypeError(`${label}: expected a source with a consume() method.`)
  }
  const logger =
    options.logger === undefined
      ? consoleLogger
      : checkLogger(label, options.logger)

  const controller = new AbortController()
  const stop = () => controller.abort()
  options.signal?.addEventListener('abort', stop, { once: true })
  if (options.signal?.aborted) stop()

  logger.info(
    { source: source.kind, listeners: worker.listeners },
    'Event worker started'
  )
  const done = source
    .consume(worker, { signal: controller.signal, logger })
    .finally(() => {
      options.signal?.removeEventListener('abort', stop)
      logger.info({ source: source.kind }, 'Event worker stopped')
    })

  return {
    stop: () => {
      stop()
      return done
    },
    done,
  }
}
