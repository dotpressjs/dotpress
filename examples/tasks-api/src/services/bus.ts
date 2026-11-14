import {
  createEventBus,
  createMemoryTransport,
  type EventBusOptions,
  type ListenerDefinition,
  type Transport,
} from '@dotpress/events'
import { createBullmqTransport } from '@dotpress/events/bullmq'
import type { Config } from '../config.ts'

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
    // Required by the BullMQ workers.
    maxRetriesPerRequest: null,
  }
}

/** A transport, and how to close it on shutdown. */
export type ClosableTransport = Transport & { close(): Promise<void> }

/**
 * With `REDIS_URL`, the events go to a BullMQ queue, handled by the worker
 * (`npm run worker`). Without it, an in-memory queue runs the listeners in
 * the API process.
 */
export const createTransport = (
  config: Pick<Config, 'REDIS_URL' | 'EVENTS_QUEUE'>
): ClosableTransport => {
  if (config.REDIS_URL) {
    return createBullmqTransport({
      queue: config.EVENTS_QUEUE,
      connection: redisConnection(config.REDIS_URL),
    })
  }
  const memory = createMemoryTransport()
  // On shutdown, waits for the listeners in progress.
  return Object.assign(memory, { close: () => memory.drain() })
}

/** The event bus of the API: one message per listener of each event. */
export const createBus = (
  transport: Transport,
  listeners: readonly ListenerDefinition[],
  options: Pick<EventBusOptions, 'logger' | 'onFailure'> = {}
) => createEventBus({ transport, listeners, ...options })
