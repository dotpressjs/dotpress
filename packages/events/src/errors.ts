import type { EmitResult } from './bus.js'

/** Base class of the errors thrown by `@dotpress/events`. */
export class EventsError extends Error {
  override name = 'EventsError'
}

/** Problem found in the payload of an event. */
export interface EventPayloadIssue {
  /** Path of the invalid value, empty for the payload itself. */
  readonly path: readonly (string | number)[]
  readonly message: string
}

const describeIssues = (issues: readonly EventPayloadIssue[]) =>
  issues
    .map(({ path, message }) =>
      path.length > 0 ? `${path.join('.')}: ${message}` : message
    )
    .join('; ')

/** The payload passed to `emit()` does not match the schema of the event. */
export class EventPayloadError extends EventsError {
  override name = 'EventPayloadError'

  constructor(
    /** Name of the event. */
    readonly event: string,
    readonly issues: readonly EventPayloadIssue[]
  ) {
    super(`Invalid payload for event "${event}": ${describeIssues(issues)}`)
  }
}

/**
 * A transport did not answer within the `sendTimeout` of the bus: the error
 * of its messages in `EventEmitError#failed`. The send may still complete
 * later; `retry()` sends the same message ids, which queues that
 * deduplicate ignore.
 */
export class EventSendTimeoutError extends EventsError {
  override name = 'EventSendTimeoutError'

  constructor(
    /** Name of the transport (`default`, `edge`…). */
    readonly transport: string,
    /** The `sendTimeout` of the bus, in milliseconds. */
    readonly timeout: number
  ) {
    super(`Transport "${transport}" did not answer within ${timeout} ms.`)
  }
}

/** A message sent by `emit()`: one per listener. */
export interface MessageRef {
  /**
   * Identifier of the message: stable across the retries of the transport
   * and of `EventEmitError#retry()`.
   */
  readonly id: string
  readonly listener: string
  /** Name of the transport (`default`, `edge`…). */
  readonly transport: string
}

/** A message that `emit()` could not send. */
export interface FailedMessage extends MessageRef {
  readonly error: unknown
}

/**
 * Some messages of an emission could not be sent; `sent` lists the others.
 * `retry()` sends the failed messages again, with the same ids. Emitting
 * again sends every message, and gives the same ids only with the same
 * `emissionId` option.
 */
export class EventEmitError extends EventsError {
  override name = 'EventEmitError'

  /** Sends the failed messages again: kept private, as they hold the payload. */
  readonly #retry: (() => Promise<EmitResult>) | undefined

  constructor(
    /** Name of the event. */
    readonly event: string,
    readonly sent: readonly MessageRef[],
    readonly failed: readonly FailedMessage[],
    retry?: () => Promise<EmitResult>
  ) {
    const [first] = failed
    const reason =
      first?.error instanceof Error ? first.error.message : String(first?.error)
    super(
      `Event "${event}" not fully emitted: ${failed.length} of ${sent.length + failed.length} messages failed (${failed.map(({ listener }) => listener).join(', ')}): ${reason}`,
      { cause: first?.error }
    )
    this.#retry = retry
  }

  /**
   * Sends the failed messages again, to the same transports, with the same
   * ids, delay and metadata; the sent ones are not sent again. Resolves
   * with the result of the emission once every message is sent, or throws
   * a new `EventEmitError`, whose `sent` also lists the messages sent
   * before.
   */
  retry(): Promise<EmitResult> {
    if (this.#retry === undefined) {
      return Promise.reject(
        new EventsError(
          `Event "${this.event}": this EventEmitError was not thrown by emit(), it cannot be retried.`
        )
      )
    }
    return this.#retry()
  }
}

/**
 * Thrown by a transport when some messages of a `send()` call failed;
 * other errors mean that every message failed.
 */
export class PartialSendError extends EventsError {
  override name = 'PartialSendError'

  constructor(
    /** Failed messages, by id. */
    readonly failed: readonly { readonly id: string; readonly error: unknown }[]
  ) {
    super(`${failed.length} messages not sent.`)
  }
}
