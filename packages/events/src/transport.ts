import type { Envelope } from './envelope.js'
import type { EventsLogger } from './logger.js'
import type { Worker } from './worker.js'

/** Options of `transport.send()`. */
export interface SendOptions {
  /**
   * Delay before delivery, in whole seconds: the `delay` of `emit()`,
   * rounded up.
   */
  readonly delay: number | undefined
  /**
   * Aborted when the bus stops waiting (its `sendTimeout`): a transport that
   * can cancel its request should. Not given to in-process transports.
   */
  readonly signal?: AbortSignal | undefined
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
   * Releases the connections of the transport. `bus.close()` calls it, and
   * `eventsPlugin()` when the app closes.
   */
  close?(): Promise<void>
}

/** What the bus gives an in-process transport (`sync`, `memory`). */
interface InProcess {
  /** Receives the worker that runs the listeners routed to the transport. */
  bind(worker: Worker): void
  /** Attempts per message, for `FailureInfo.final`. */
  readonly maxAttempts: number
}

const inProcess = new WeakMap<Transport, InProcess>()

/** Marks a transport as in-process: the bus binds it to a worker. */
export const runsInProcess = <T extends Transport>(
  transport: T,
  hooks: InProcess
): T => {
  inProcess.set(transport, hooks)
  return transport
}

/** The in-process hooks of a transport, if it has some. */
export const inProcessOf = (transport: Transport): InProcess | undefined =>
  inProcess.get(transport)

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
