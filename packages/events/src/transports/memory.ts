import type { Envelope } from '../envelope.js'
import type { Transport } from '../transport.js'
import type { Worker } from '../worker.js'

/** Options of `createMemoryTransport()`. */
export interface MemoryTransportOptions {
  /** Attempts per message, the first included. Defaults to 3. */
  maxAttempts?: number | undefined
  /**
   * Delay before an attempt, in milliseconds, given the number of the
   * failed attempt. Defaults to 100 ms, doubled at each attempt.
   */
  retryDelay?: ((attempt: number) => number) | undefined
}

/** In-process queue, for development and tests. */
export interface MemoryTransport extends Transport {
  /** Every message sent, oldest first. */
  readonly sent: readonly Envelope[]
  /** Resolves when no message is waiting or running. */
  drain(): Promise<void>
  /** Forgets the sent messages (not the pending ones). */
  clear(): void
}

/**
 * Creates a transport that queues messages in memory and runs their
 * listeners in the same process, with retries. Messages are lost when the
 * process stops: use a real queue in production.
 */
export const createMemoryTransport = (
  options: MemoryTransportOptions = {}
): MemoryTransport => {
  const label = 'createMemoryTransport()'
  const {
    maxAttempts = 3,
    retryDelay = (attempt: number) => 100 * 2 ** (attempt - 1),
  } = options ?? {}
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(`${label}: maxAttempts must be a positive integer.`)
  }
  if (typeof retryDelay !== 'function') {
    throw new TypeError(`${label}: retryDelay must be a function.`)
  }

  const sent: Envelope[] = []
  let worker: Worker | undefined
  let pending = 0
  const idle: (() => void)[] = []

  const settle = () => {
    pending -= 1
    if (pending === 0) {
      for (const resolve of idle.splice(0)) resolve()
    }
  }

  const schedule = (json: string, attempt: number, delayMs: number) => {
    pending += 1
    setTimeout(() => {
      void (async () => {
        const result = await (worker as Worker).handle(json, { attempt })
        if (result.status === 'retry' && attempt < maxAttempts) {
          schedule(json, attempt + 1, retryDelay(attempt))
        }
        settle()
      })()
    }, delayMs)
  }

  return {
    kind: 'memory',
    maxAttempts,
    sent,
    bind: (bound) => {
      worker = bound
    },
    send: async (envelopes, { delay }) => {
      if (!worker) {
        throw new Error('The memory transport is not used by an event bus.')
      }
      for (const envelope of envelopes) {
        // Through JSON, like the other transports.
        const json = JSON.stringify(envelope)
        sent.push(JSON.parse(json) as Envelope)
        schedule(json, 1, (delay ?? 0) * 1000)
      }
    },
    drain: () =>
      pending === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idle.push(resolve)
          }),
    clear: () => {
      sent.length = 0
    },
  }
}
