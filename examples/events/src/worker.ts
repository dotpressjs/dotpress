import { createConsoleLogger } from '@dotpress/core'
import { createWorker } from '@dotpress/events'
import { createBullmqSource } from '@dotpress/events/bullmq'
import { queueName, redisConnection } from './bus.ts'
import { listeners } from './events.ts'

// Entry of `dotpress-events work src/worker.ts`: reads the BullMQ queue and
// runs the listeners, until Ctrl+C or SIGTERM (it then finishes the jobs in
// progress). In production, run it in its own container.
const redisUrl = process.env.REDIS_URL
if (!redisUrl) {
  throw new Error(
    'REDIS_URL is required: without it, the API runs the listeners itself.'
  )
}

export const logger = createConsoleLogger({ bindings: { process: 'worker' } })

export default {
  worker: createWorker({
    listeners,
    logger,
    // The attempts of the BullMQ jobs (3 by default): the last failure is
    // reported as final, for alerts.
    maxAttempts: 3,
    onFailure: (error, { envelope, attempt, final }) => {
      if (final) {
        logger.error(
          { error, listener: envelope?.listener, id: envelope?.id, attempt },
          'Event listener gave up: the job stays in the failed jobs'
        )
      }
    },
  }),
  source: createBullmqSource({
    queue: queueName(),
    connection: redisConnection(redisUrl),
    concurrency: 5,
  }),
  logger,
}
