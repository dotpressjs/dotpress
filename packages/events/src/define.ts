import type { z } from 'zod'
import type { EventsLogger } from './logger.js'

/**
 * Names of the transports, besides `default`, declared by module
 * augmentation so that typos are type errors:
 *
 * ```ts
 * declare module '@dotpress/events' {
 *   interface EventTransports {
 *     edge: true
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EventTransports {}

/** Name of a transport: `default`, or a name of `EventTransports`. */
export type TransportName = 'default' | Extract<keyof EventTransports, string>

/** Event created by `defineEvent()`. */
export interface EventDefinition<S extends z.ZodType = z.ZodType> {
  readonly name: string
  readonly schema: S
  /** Transport of its listeners; undefined for `default`. */
  readonly transport: TransportName | undefined
}

/** Payload accepted by `emit()` for an event. */
export type EventInput<E> =
  E extends EventDefinition<infer S> ? z.input<S> : never

/** Payload received by the listeners of an event. */
export type EventPayload<E> =
  E extends EventDefinition<infer S> ? z.output<S> : never

/** Context of a listener call. */
export interface ListenerContext<TPayload = unknown> {
  /** Payload, validated by the schema of the event. */
  readonly payload: TPayload
  /** Name of the event. */
  readonly event: string
  /** Name of the listener. */
  readonly listener: string
  /**
   * Identifier of the message, the same for every attempt and when the
   * emission is repeated: use it to ignore duplicates.
   */
  readonly id: string
  /** Identifier of the emission, shared by the messages of its listeners. */
  readonly emissionId: string
  /** Attempt number, from 1. */
  readonly attempt: number
  readonly emittedAt: Date
  /** Metadata of the emission (request ID…). */
  readonly metadata: Readonly<Record<string, string>>
  readonly logger: EventsLogger
}

/** Function of a listener. Throw to have the message retried. */
export type ListenerHandler<TPayload = unknown> = (
  context: ListenerContext<TPayload>
) => unknown

/** Module loaded by `load()`: the handler is its default export. */
export interface ListenerModule<TPayload = unknown> {
  default: ListenerHandler<TPayload>
}

/** Options of `defineListener()`. */
export type ListenerOptions<TPayload> = {
  /**
   * Unique name: letters, digits, `.`, `_`, `:` and `-`. It identifies the
   * listener in messages: renaming it orphans messages still in queues.
   */
  name: string
  /** Transport of this listener; defaults to the one of the event. */
  transport?: TransportName | undefined
} & (
  | { handle: ListenerHandler<TPayload>; load?: never }
  | {
      /**
       * Loads the module of the handler on first use, so that the code
       * emitting events does not load the code of the listeners:
       * `load: () => import('./listeners/send-welcome-mail.js')`.
       */
      load: () => Promise<ListenerModule<TPayload>>
      handle?: never
    }
)

/** Listener created by `defineListener()`. */
export interface ListenerDefinition<S extends z.ZodType = z.ZodType> {
  readonly name: string
  readonly event: EventDefinition<S>
  /** Transport of this listener, if it differs from the one of its event. */
  readonly transport: TransportName | undefined
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const checkName = (prefix: string, kind: string, name: unknown) => {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new TypeError(
      `${prefix}: ${kind} must have 1 to 128 letters, digits, ".", "_", ":" or "-", starting with a letter or a digit.`
    )
  }
}

const checkTransport = (prefix: string, transport: unknown) => {
  if (
    transport !== undefined &&
    (typeof transport !== 'string' || transport === '')
  ) {
    throw new TypeError(`${prefix}: transport must be a non-empty string.`)
  }
}

const checkKeys = (
  prefix: string,
  options: unknown,
  allowed: ReadonlySet<string>
): Record<string, unknown> => {
  if (!isRecord(options)) throw new TypeError(`${prefix}: expected an object.`)
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${prefix}: unknown option "${key}".`)
    }
  }
  return options
}

const events = new WeakSet<object>()
const loaders = new WeakMap<object, () => Promise<ListenerHandler>>()

/** Whether a value was created by `defineEvent()`. */
export const isEvent = (value: unknown): value is EventDefinition =>
  // WeakSet.has() returns false for other values.
  events.has(value as object)

/** Handler loader of a listener, or undefined for another value. */
export const loaderOf = (listener: unknown) => loaders.get(listener as object)

/**
 * Defines an event: a fact that listeners react to, with the schema of its
 * payload.
 *
 * ```ts
 * export const userCreated = defineEvent({
 *   name: 'user.created',
 *   schema: z.object({ userId: z.string() }),
 * })
 * ```
 */
export const defineEvent = <S extends z.ZodType>(options: {
  /** Unique name: letters, digits, `.`, `_`, `:` and `-`. */
  name: string
  /**
   * Schema of the payload. Payloads travel as JSON: describe JSON values
   * (dates as strings, or coerced on the way in).
   */
  schema: S
  /** Transport of the listeners. Defaults to `default`. */
  transport?: TransportName | undefined
}): EventDefinition<S> => {
  const name = (options as { name?: unknown } | null)?.name
  const prefix =
    typeof name === 'string' ? `Invalid event "${name}"` : 'Invalid event'
  const values = checkKeys(
    prefix,
    options,
    new Set(['name', 'schema', 'transport'])
  )
  checkName(prefix, 'name', name)
  if (
    typeof (values.schema as { safeParseAsync?: unknown } | null)
      ?.safeParseAsync !== 'function'
  ) {
    throw new TypeError(`${prefix}: schema must be a Zod schema.`)
  }
  checkTransport(prefix, values.transport)

  const event: EventDefinition<S> = Object.freeze({
    name: name as string,
    schema: values.schema as S,
    transport: values.transport as TransportName | undefined,
  })
  events.add(event)
  return event
}

/**
 * Defines a listener of an event. Its handler runs in a worker, once per
 * emission, and is retried when it throws.
 *
 * ```ts
 * export const sendWelcomeMail = defineListener(userCreated, {
 *   name: 'send-welcome-mail',
 *   load: () => import('./listeners/send-welcome-mail.js'),
 * })
 * ```
 */
export const defineListener = <S extends z.ZodType>(
  event: EventDefinition<S>,
  options: ListenerOptions<z.output<S>>
): ListenerDefinition<S> => {
  const name = (options as { name?: unknown } | null)?.name
  const prefix =
    typeof name === 'string' ? `Invalid listener "${name}"` : 'Invalid listener'
  if (!isEvent(event)) {
    throw new TypeError(
      `${prefix}: expected an event created by defineEvent().`
    )
  }
  const values = checkKeys(
    prefix,
    options,
    new Set(['name', 'transport', 'handle', 'load'])
  )
  checkName(prefix, 'name', name)
  checkTransport(prefix, values.transport)

  const { handle, load } = values
  if ((handle === undefined) === (load === undefined)) {
    throw new TypeError(`${prefix}: set exactly one of handle and load.`)
  }
  if (typeof (handle ?? load) !== 'function') {
    throw new TypeError(
      `${prefix}: ${handle === undefined ? 'load' : 'handle'} must be a function.`
    )
  }

  const listener: ListenerDefinition<S> = Object.freeze({
    name: name as string,
    event,
    transport: values.transport as TransportName | undefined,
  })

  let loading: Promise<ListenerHandler> | undefined
  loaders.set(
    listener,
    handle === undefined
      ? () =>
          (loading ??= (load as () => Promise<unknown>)().then((module) => {
            const loaded = (module as { default?: unknown } | null)?.default
            if (typeof loaded !== 'function') {
              throw new TypeError(
                `Listener "${name as string}": load() must resolve to a module whose default export is the handler.`
              )
            }
            return loaded as ListenerHandler
          })).catch((error: unknown) => {
            // A failed import is tried again on the next message.
            loading = undefined
            throw error
          })
      : () => Promise.resolve(handle as ListenerHandler)
  )
  return listener
}
