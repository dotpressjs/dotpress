import { retryDelayOf, type Duration } from '../duration.js'
import type { Envelope } from '../envelope.js'
import { runsInProcess, type Transport } from '../transport.js'
import type { Worker } from '../worker.js'

/** Options of `createMemoryTransport()`. */
export interface MemoryTransportOptions {
  /** Attempts per message, the first included. Defaults to 3. */
  maxAttempts?: number | undefined
  /**
   * Delay before an attempt, given the number of the failed attempt: a
   * number of seconds, or a duration like `'100ms'`. Defaults to 100 ms,
   * doubled at each attempt.
   */
  retryDelay?: ((attempt: number) => Duration) | undefined
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
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (key !== 'maxAttempts' && key !== 'retryDelay') {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  const {
    maxAttempts = 3,
    retryDelay = (attempt: number) => 0.1 * 2 ** (attempt - 1),
  } = options
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
          schedule(json, attempt + 1, retryDelayOf(label, retryDelay, attempt))
        }
        settle()
      })()
    }, delayMs)
  }

  const transport: MemoryTransport = {
    kind: 'memory',
    sent,
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
  return runsInProcess(transport, {
    maxAttempts,
    bind: (bound) => {
      worker = bound
    },
  })
}
