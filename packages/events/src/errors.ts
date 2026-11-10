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

/** A message sent by `emit()`: one per listener. */
export interface MessageRef {
  /** Identifier of the message, stable across retries. */
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
 * Some messages of an emission could not be sent. `sent` lists the
 * others: emitting again gives the same message ids, so listeners can
 * ignore duplicates.
 */
export class EventEmitError extends EventsError {
  override name = 'EventEmitError'

  constructor(
    /** Name of the event. */
    readonly event: string,
    readonly sent: readonly MessageRef[],
    readonly failed: readonly FailedMessage[]
  ) {
    const [first] = failed
    const reason =
      first?.error instanceof Error ? first.error.message : String(first?.error)
    super(
      `Event "${event}" not fully emitted: ${failed.length} of ${sent.length + failed.length} messages failed (${failed.map(({ listener }) => listener).join(', ')}): ${reason}`,
      { cause: first?.error }
    )
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
