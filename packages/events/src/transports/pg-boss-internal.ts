// Internals of the pg-boss transport, tested on their own.
import type { Job, JobResult, QueueOptions } from 'pg-boss'
import type { Envelope } from '../envelope.js'
import type { Worker } from '../worker.js'

export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  retryLimit: 2,
  retryDelay: 1,
  retryBackoff: true,
}

export const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Handler of a batch of jobs, with a result per job: completed, failed
 * (retried within the retry limit), or sent to the dead-letter queue.
 */
export const handlerOf =
  (worker: Worker, deadLetter: () => string | undefined) =>
  (jobs: Job<Envelope>[]): Promise<JobResult[]> =>
    Promise.all(
      jobs.map(async ({ id, data, retryCount }) => {
        const result = await worker.handle(data, { attempt: retryCount + 1 })
        if (result.status === 'success') return { id, status: 'completed' }
        return {
          id,
          // Without dead-letter queue, dead messages fail until the limit.
          status:
            result.status === 'dead' && deadLetter() ? 'deadletter' : 'failed',
          output: {
            reason: result.status === 'dead' ? result.reason : 'listener-error',
            error: describe(result.error),
          },
        }
      })
    )
