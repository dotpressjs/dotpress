// Internals of the BullMQ transport, tested on their own.
import { UnrecoverableError, type Job, type JobsOptions } from 'bullmq'
import type { Envelope } from '../envelope.js'
import type { Worker } from '../worker.js'

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: false,
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
