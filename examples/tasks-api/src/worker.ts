import { createConsoleLogger } from '@dotpress/core'
import { createWorker } from '@dotpress/events'
import { createBullmqSource } from '@dotpress/events/bullmq'
import { loadConfig, requireInProduction } from './config.ts'
import { openDatabase } from './db/database.ts'
import { createNotifications } from './features/notifications/listeners.ts'
import { redisConnection } from './services/bus.ts'
import { createRepositories } from './services/index.ts'
import { createAppMailer, createMailProvider } from './services/mailer.ts'

// Entry of `dotpress-events work src/worker.ts` (npm run worker): reads the
// BullMQ queue and runs the listeners, until Ctrl+C or SIGTERM, which wait
// for the jobs in progress. It opens the same SQLite file as the API.
const config = loadConfig()
requireInProduction(config, ['SMTP_URL'])
if (!config.REDIS_URL) {
  throw new Error(
    'REDIS_URL is required: without it, the API runs the listeners itself.'
  )
}

export const logger = createConsoleLogger({ bindings: { process: 'worker' } })

// The services of the worker: the database and the mailer only.
const repositories = createRepositories(openDatabase(config.DATABASE_PATH))
const mailer = createAppMailer(createMailProvider(config), config.MAIL_FROM)

export default {
  worker: createWorker({
    listeners: createNotifications({ repositories, mailer }),
    logger,
    // The attempts of the BullMQ jobs (3 by default): the last failure is
    // reported as final, for alerts.
    maxAttempts: 3,
    onFailure: (error, { envelope, attempt, final }) => {
      if (final) {
        logger.error(
          { error, listener: envelope?.listener, id: envelope?.id, attempt },
          'Notification given up: the job stays in the failed jobs'
        )
      }
    },
  }),
  source: createBullmqSource({
    queue: config.EVENTS_QUEUE,
    connection: redisConnection(config.REDIS_URL),
    concurrency: 5,
  }),
  logger,
}
