import {
  loaderOf,
  type ListenerDefinition,
  type ListenerHandler,
} from './define.js'
import { parseEnvelope, type Envelope } from './envelope.js'
import { checkLogger, consoleLogger, type EventsLogger } from './logger.js'

/** Why a message can never be handled: retrying would not help. */
export type DeadReason =
  /** Not an envelope of Dotpress. */
  | 'invalid-envelope'
  /** No listener of this name in this worker (not deployed here?). */
  | 'unknown-listener'
  /** The payload does not match the schema of the event. */
  | 'invalid-payload'

/** Why a message is retried. */
export type RetryReason =
  /** The listener failed. */
  | 'listener-error'
  /**
   * An envelope of a later version (`v`), emitted by a newer deployment:
   * retried until a newer worker handles it, during a rolling deployment.
   */
  | 'unsupported-version'

/** Result of `worker.handle()`, translated by each transport. */
export type HandleResult =
  | { readonly status: 'success' }
  /** The listener failed, or the envelope is too recent: retry it. */
  | { readonly status: 'retry'; readonly error: unknown }
  /** The message can never be handled: do not retry it. */
  | {
      readonly status: 'dead'
      readonly reason: DeadReason
      readonly error: unknown
    }

/** Details of a failure, for `onFailure`. */
export interface FailureInfo {
  /** Envelope of the message; undefined when it is not an envelope. */
  readonly envelope: Envelope | undefined
  readonly reason: RetryReason | DeadReason
  readonly attempt: number
  /**
   * Whether the message will not be retried: a dead message, or the last
   * attempt (with `maxAttempts`).
   */
  readonly final: boolean
}

/** Called for every failure: logs, alerts… */
export type FailureHook = (
  error: unknown,
  info: FailureInfo
) => void | Promise<void>

/** Options of `createWorker()`. */
export interface WorkerOptions {
  /** Listeners run by this worker. */
  listeners: readonly ListenerDefinition[]
  logger?: EventsLogger | undefined
  /** Called for every failure. Its own errors are logged and ignored. */
  onFailure?: FailureHook | undefined
  /**
   * Attempts before the transport gives up (its retry limit, like the
   * `maxReceiveCount` of an SQS queue), to report the last one as `final`.
   */
  maxAttempts?: number | undefined
}

/** Runs the listeners of received messages. */
export interface Worker {
  /** Names of its listeners. */
  readonly listeners: readonly string[]
  /**
   * Handles a received message (an envelope, or its JSON). Never throws:
   * the result tells the transport what to do with the message.
   */
  handle(
    message: unknown,
    options?: { attempt?: number | undefined }
  ): Promise<HandleResult>
}

const OPTIONS = new Set(['listeners', 'logger', 'onFailure', 'maxAttempts'])

/** Checks a list of listeners; returns them by name. */
export const listenersByName = (label: string, listeners: unknown) => {
  if (!Array.isArray(listeners)) {
    throw new TypeError(`${label}: listeners must be a list.`)
  }
  const byName = new Map<string, ListenerDefinition>()
  for (const listener of listeners as unknown[]) {
    if (!loaderOf(listener)) {
      throw new TypeError(
        `${label}: listeners must be created by defineListener().`
      )
    }
    const { name } = listener as ListenerDefinition
    if (byName.has(name)) {
      throw new TypeError(`${label}: two listeners are named "${name}".`)
    }
    byName.set(name, listener as ListenerDefinition)
  }
  return byName
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Creates a worker: it runs the listeners of the messages it receives from
 * a transport (Lambda handler, queue consumer, `startWorker()`…).
 *
 * ```ts
 * const worker = createWorker({ listeners: [sendWelcomeMail, geocodeUser] })
 * export const handler = createSqsHandler(worker)
 * ```
 */
export const createWorker = (options: WorkerOptions): Worker => {
  const label = 'createWorker()'
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key)) {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  const listeners = listenersByName(label, options.listeners)
  const logger =
    options.logger === undefined
      ? consoleLogger
      : checkLogger(label, options.logger)
  const { onFailure, maxAttempts } = options
  if (onFailure !== undefined && typeof onFailure !== 'function') {
    throw new TypeError(`${label}: onFailure must be a function.`)
  }
  if (
    maxAttempts !== undefined &&
    (!Number.isInteger(maxAttempts) || maxAttempts < 1)
  ) {
    throw new TypeError(`${label}: maxAttempts must be a positive integer.`)
  }

  const fail = async (
    error: unknown,
    info: FailureInfo
  ): Promise<HandleResult> => {
    const fields = {
      event: info.envelope?.event,
      listener: info.envelope?.listener,
      messageId: info.envelope?.id,
      attempt: info.attempt,
      reason: info.reason,
      error: describe(error),
    }
    if (info.final) {
      logger.error(fields, 'Event listener failed, the message is not retried')
    } else {
      logger.warn(fields, 'Event listener failed, the message is retried')
    }
    if (onFailure) {
      try {
        await onFailure(error, info)
      } catch (hookError) {
        logger.error(
          { ...fields, hookError: describe(hookError) },
          'onFailure hook failed'
        )
      }
    }
    return info.reason === 'listener-error' ||
      info.reason === 'unsupported-version'
      ? { status: 'retry', error }
      : { status: 'dead', reason: info.reason, error }
  }

  const handle: Worker['handle'] = async (message, handleOptions = {}) => {
    const attempt = handleOptions.attempt ?? 1
    const parsed = parseEnvelope(message)
    if ('unsupportedVersion' in parsed) {
      return fail(
        new Error(
          `Envelope version ${parsed.unsupportedVersion} is not supported by this worker: a newer deployment emitted it.`
        ),
        {
          envelope: undefined,
          reason: 'unsupported-version',
          attempt,
          final: maxAttempts !== undefined && attempt >= maxAttempts,
        }
      )
    }
    if ('problem' in parsed) {
      return fail(new Error(`Invalid message: ${parsed.problem}.`), {
        envelope: undefined,
        reason: 'invalid-envelope',
        attempt,
        final: true,
      })
    }
    const { envelope } = parsed
    const dead = (reason: DeadReason, text: string) =>
      fail(new Error(text), { envelope, reason, attempt, final: true })

    const listener = listeners.get(envelope.listener)
    if (!listener) {
      return dead(
        'unknown-listener',
        `Unknown listener "${envelope.listener}": this worker runs ${[...listeners.keys()].join(', ') || 'no listener'}.`
      )
    }
    if (listener.event.name !== envelope.event) {
      return dead(
        'invalid-envelope',
        `Listener "${listener.name}" listens to "${listener.event.name}", not "${envelope.event}".`
      )
    }

    let result: Awaited<ReturnType<typeof listener.event.schema.safeParseAsync>>
    try {
      result = await listener.event.schema.safeParseAsync(envelope.payload)
    } catch (error) {
      // A refinement that throws (database lookup…): may succeed later.
      return fail(error, {
        envelope,
        reason: 'listener-error',
        attempt,
        final: maxAttempts !== undefined && attempt >= maxAttempts,
      })
    }
    if (!result.success) {
      const issues = result.error.issues
        .map(({ path, message: text }) =>
          path.length > 0 ? `${path.map(String).join('.')}: ${text}` : text
        )
        .join('; ')
      return dead(
        'invalid-payload',
        `Invalid payload for event "${envelope.event}": ${issues}`
      )
    }

    const context = {
      payload: result.data,
      event: envelope.event,
      listener: envelope.listener,
      id: envelope.id,
      emissionId: envelope.emissionId,
      attempt,
      emittedAt: new Date(envelope.emittedAt),
      metadata: envelope.metadata,
      logger,
    }
    try {
      const handler: ListenerHandler = await (
        loaderOf(listener) as () => Promise<ListenerHandler>
      )()
      await handler(context)
    } catch (error) {
      return fail(error, {
        envelope,
        reason: 'listener-error',
        attempt,
        final: maxAttempts !== undefined && attempt >= maxAttempts,
      })
    }
    logger.debug?.(
      {
        event: envelope.event,
        listener: envelope.listener,
        messageId: envelope.id,
        attempt,
      },
      'Event listener succeeded'
    )
    return { status: 'success' }
  }

  return Object.freeze({
    listeners: Object.freeze([...listeners.keys()]),
    handle,
  })
}
