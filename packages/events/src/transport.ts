import type { Envelope } from './envelope.js'
import type { EventsLogger } from './logger.js'
import type { Worker } from './worker.js'

/** Options of `transport.send()`. */
export interface SendOptions {
  /** Delay before delivery, in seconds. */
  readonly delay: number | undefined
}

/**
 * Sends messages to a queue. Implemented by each transport (SQS, BullMQ,
 * Cloudflare Queues…); throw a `PartialSendError` when only some messages
 * failed.
 */
export interface Transport {
  /** Kind of transport, for logs: `sqs`, `memory`… */
  readonly kind: string
  send(envelopes: readonly Envelope[], options: SendOptions): Promise<void>
  /**
   * In-process transports only (`sync`, `memory`): receives the worker
   * that runs the listeners routed to this transport.
   */
  bind?(worker: Worker): void
  /** Attempts of an in-process transport, for `FailureInfo.final`. */
  readonly maxAttempts?: number
}

/** Options of `source.consume()`. */
export interface ConsumeOptions {
  /** Aborted to stop: finish the messages in progress, then resolve. */
  readonly signal: AbortSignal
  readonly logger: EventsLogger
}

/**
 * Reads messages from a queue and hands them to a worker, until stopped:
 * the long-running side of a transport (SQS polling, BullMQ worker…).
 */
export interface Source {
  /** Kind of source, for logs. */
  readonly kind: string
  consume(worker: Worker, options: ConsumeOptions): Promise<void>
}

/** Whether a value has the shape of a transport. */
export const isTransport = (value: unknown): value is Transport =>
  typeof (value as Transport | null)?.send === 'function' &&
  typeof (value as Transport).kind === 'string'
