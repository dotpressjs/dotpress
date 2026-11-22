import {
  createEventBus,
  createMemoryTransport,
  type EventBusOptions,
  type Transport,
} from '@dotpress/events'
import { createBullmqTransport } from '@dotpress/events/bullmq'
import { listeners } from './events.ts'

type Env = Record<string, string | undefined>

/** Name of the BullMQ queue, shared by the API and the worker. */
export const queueName = (env: Env = process.env) =>
  env.EVENTS_QUEUE ?? 'events'

/** BullMQ connection options from a Redis URL (`redis://` or `rediss://`). */
export const redisConnection = (redisUrl: string) => {
  const url = new URL(redisUrl)
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username && { username: decodeURIComponent(url.username) }),
    ...(url.password && { password: decodeURIComponent(url.password) }),
    ...(url.pathname.length > 1 && { db: Number(url.pathname.slice(1)) }),
    ...(url.protocol === 'rediss:' && { tls: {} }),
  }
}

/** A transport, and how to close it on shutdown. */
export type ClosableTransport = Transport & { close(): Promise<void> }

/**
 * With `REDIS_URL`, the events go to a BullMQ queue, handled by the worker
 * (`npm run worker`). Without it, an in-memory queue runs the listeners in
 * this process: development without Redis.
 */
export const createTransport = (env: Env = process.env): ClosableTransport => {
  if (env.REDIS_URL) {
    return createBullmqTransport({
      queue: queueName(env),
      // While Redis is unreachable, emit() fails at once.
      connection: {
        ...redisConnection(env.REDIS_URL),
        enableOfflineQueue: false,
      },
    })
  }
  const memory = createMemoryTransport()
  // Waits for the listeners in progress.
  return Object.assign(memory, { close: () => memory.drain() })
}

/** The event bus of the API. */
export const createBus = (
  transport: Transport,
  options: Pick<EventBusOptions, 'logger' | 'onFailure'> = {}
) => createEventBus({ transport, listeners, ...options })
