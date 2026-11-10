import {
  isEvent,
  type EventDefinition,
  type EventInput,
  type ListenerDefinition,
  type TransportName,
} from './define.js'
import { messageId, type Envelope } from './envelope.js'
import {
  EventEmitError,
  EventPayloadError,
  PartialSendError,
  type FailedMessage,
  type MessageRef,
} from './errors.js'
import { checkLogger, silentLogger, type EventsLogger } from './logger.js'
import { isTransport, type Transport } from './transport.js'
import { createWorker, listenersByName, type FailureHook } from './worker.js'

/** Options of `createEventBus()`. */
export type EventBusOptions = {
  /**
   * Every listener of the app, with their routes: the bus sends one
   * message per listener of an emitted event. Workers only need the
   * listeners they run.
   */
  listeners: readonly ListenerDefinition[]
  logger?: EventsLogger | undefined
  /**
   * Failures of the listeners run by in-process transports (`sync`,
   * `memory`). Workers have their own.
   */
  onFailure?: FailureHook | undefined
} & (
  | {
      /** The transport of every event. */
      transport: Transport
      transports?: never
    }
  | {
      /** Transports by name; events without a `transport` use `default`. */
      transports: { readonly [K in TransportName]?: Transport }
      transport?: never
    }
)

/** Options of `emit()`. */
export interface EmitOptions {
  /** Delay before delivery, in seconds, within the limit of the transport. */
  delay?: number | undefined
  /** Metadata of the emission, passed to the listeners. */
  metadata?: Readonly<Record<string, string>> | undefined
}

/** Result of `emit()`. */
export interface EmitResult {
  readonly emissionId: string
  /** One message per listener of the event. */
  readonly messages: readonly MessageRef[]
}

/** Context of a bus: the logger and metadata of a request, for instance. */
export interface EventBusContext {
  logger?: EventsLogger | undefined
  /** Added to the metadata of every emission. */
  metadata?: Readonly<Record<string, string>> | undefined
}

export interface EventBus {
  /**
   * Emits an event: validates its payload, then sends one message per
   * listener to the transport of the listener.
   */
  emit<E extends EventDefinition>(
    event: E,
    payload: EventInput<E>,
    options?: EmitOptions
  ): Promise<EmitResult>
  /** The same bus, with another logger and additional metadata. */
  withContext(context: EventBusContext): EventBus
}

const OPTIONS = new Set([
  'listeners',
  'logger',
  'onFailure',
  'transport',
  'transports',
])
const METADATA_KEY = /^[A-Za-z0-9._-]{1,128}$/
const LINE_BREAK = /[\r\n]/

export const checkMetadata = (label: string, metadata: unknown) => {
  if (metadata === undefined) return {}
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new TypeError(`${label}: metadata must be an object.`)
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_KEY.test(key)) {
      throw new TypeError(
        `${label}: metadata keys must have 1 to 128 letters, digits, ".", "_" or "-": ${JSON.stringify(key)}.`
      )
    }
    if (typeof value !== 'string' || LINE_BREAK.test(value)) {
      throw new TypeError(
        `${label}: metadata.${key} must be a string on one line.`
      )
    }
  }
  return metadata as Record<string, string>
}

/** Transport name of a listener: its own, the one of its event, or default. */
export const routeOf = (listener: ListenerDefinition): string =>
  listener.transport ?? listener.event.transport ?? 'default'

/**
 * Checks an emission like `emit()`: the event, the delay, the metadata,
 * and the payload, which travels as JSON. Returns the payload received by
 * the listeners and the metadata of the emission.
 */
export const checkEmission = async (
  event: unknown,
  payload: unknown,
  emitOptions: EmitOptions | undefined,
  contextMetadata: Readonly<Record<string, string>>
) => {
  if (!isEvent(event)) {
    throw new TypeError('emit(): expected an event created by defineEvent().')
  }
  const emitLabel = `emit("${event.name}")`
  const { delay, metadata } = emitOptions ?? {}
  if (delay !== undefined && (!Number.isInteger(delay) || delay < 0)) {
    throw new TypeError(
      `${emitLabel}: delay must be a non-negative integer (seconds).`
    )
  }
  const checked = {
    ...contextMetadata,
    ...checkMetadata(emitLabel, metadata),
  }

  // The payload travels as JSON: listeners receive this value.
  let json: unknown
  try {
    json = JSON.parse(JSON.stringify(payload) ?? 'null')
  } catch (error) {
    throw new EventPayloadError(event.name, [
      {
        path: [],
        message: `the payload cannot be serialized as JSON (${error instanceof Error ? error.message : String(error)})`,
      },
    ])
  }
  const result = await event.schema.safeParseAsync(json)
  if (!result.success) {
    throw new EventPayloadError(
      event.name,
      result.error.issues.map(({ path, message }) => ({
        path: path.map((key) => (typeof key === 'symbol' ? String(key) : key)),
        message,
      }))
    )
  }
  return { event, json, delay, metadata: checked }
}

/**
 * Creates an event bus: it validates the emitted events and sends one
 * message per listener to its transport.
 *
 * ```ts
 * const events = createEventBus({
 *   transport: createMemoryTransport(),
 *   listeners: [sendWelcomeMail, geocodePractitioner],
 * })
 * await events.emit(practitionerCreated, { practitionerId: '42' })
 * ```
 */
export const createEventBus = (options: EventBusOptions): EventBus => {
  const label = 'createEventBus()'
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
      ? silentLogger
      : checkLogger(label, options.logger)
  const { onFailure } = options
  if (onFailure !== undefined && typeof onFailure !== 'function') {
    throw new TypeError(`${label}: onFailure must be a function.`)
  }

  // Transports by name.
  if (
    (options.transport === undefined) ===
    (options.transports === undefined)
  ) {
    throw new TypeError(
      `${label}: set exactly one of transport and transports.`
    )
  }
  const transports = new Map<string, Transport>(
    options.transport === undefined
      ? Object.entries(options.transports ?? {}).filter(
          ([, transport]) => transport !== undefined
        )
      : [['default', options.transport]]
  )
  if (
    options.transports !== undefined &&
    (typeof options.transports !== 'object' || options.transports === null)
  ) {
    throw new TypeError(`${label}: transports must be an object.`)
  }
  for (const [name, transport] of transports) {
    if (!isTransport(transport)) {
      throw new TypeError(
        `${label}: the "${name}" transport must have a kind and a send() method.`
      )
    }
  }

  // Every listener needs its transport.
  const routed = new Map<string, ListenerDefinition[]>()
  for (const listener of listeners.values()) {
    const route = routeOf(listener)
    if (!transports.has(route)) {
      throw new TypeError(
        `${label}: listener "${listener.name}" (event "${listener.event.name}") uses the "${route}" transport, which is not configured.`
      )
    }
    routed.set(route, [...(routed.get(route) ?? []), listener])
  }

  // In-process transports run their listeners themselves.
  for (const [name, transport] of transports) {
    transport.bind?.(
      createWorker({
        listeners: routed.get(name) ?? [],
        logger,
        onFailure,
        maxAttempts: transport.maxAttempts,
      })
    )
  }

  const listenersOf = (event: string) =>
    [...listeners.values()].filter((listener) => listener.event.name === event)

  const create = (context: {
    logger: EventsLogger
    metadata: Readonly<Record<string, string>>
  }): EventBus => {
    const emit: EventBus['emit'] = async (event, payload, emitOptions = {}) => {
      const { json, delay, metadata } = await checkEmission(
        event,
        payload,
        emitOptions,
        context.metadata
      )

      const emissionId = crypto.randomUUID()
      const targets = listenersOf(event.name)
      if (targets.length === 0) {
        context.logger.debug?.(
          { event: event.name, emissionId },
          'Event emitted without listeners'
        )
        return { emissionId, messages: [] }
      }

      const base = {
        v: 1 as const,
        emissionId,
        event: event.name,
        payload: json,
        emittedAt: new Date().toISOString(),
        metadata,
      }
      const messages: { ref: MessageRef; envelope: Envelope }[] = []
      for (const listener of targets) {
        const id = await messageId(emissionId, listener.name)
        messages.push({
          ref: { id, listener: listener.name, transport: routeOf(listener) },
          envelope: { ...base, id, listener: listener.name },
        })
      }

      // One send() per transport, in parallel.
      const groups = new Map<string, typeof messages>()
      for (const message of messages) {
        const { transport } = message.ref
        groups.set(transport, [...(groups.get(transport) ?? []), message])
      }
      const sent: MessageRef[] = []
      const failed: FailedMessage[] = []
      await Promise.all(
        [...groups].map(async ([name, group]) => {
          try {
            await (transports.get(name) as Transport).send(
              group.map(({ envelope }) => envelope),
              { delay }
            )
            for (const { ref } of group) sent.push(ref)
          } catch (error) {
            const partial =
              error instanceof PartialSendError
                ? new Map(error.failed.map((item) => [item.id, item.error]))
                : undefined
            for (const { ref } of group) {
              if (partial && !partial.has(ref.id)) sent.push(ref)
              else failed.push({ ...ref, error: partial?.get(ref.id) ?? error })
            }
          }
        })
      )

      const order = <T extends MessageRef>(refs: T[]) =>
        refs.sort(
          (a, b) =>
            targets.findIndex(({ name }) => name === a.listener) -
            targets.findIndex(({ name }) => name === b.listener)
        )
      if (failed.length > 0) {
        throw new EventEmitError(event.name, order(sent), order(failed))
      }
      context.logger.info(
        { event: event.name, emissionId, messages: sent.length },
        'Event emitted'
      )
      return {
        emissionId,
        messages: order(messages.map(({ ref }) => ref)),
      }
    }

    return Object.freeze({
      emit,
      withContext: ({ logger: other, metadata }: EventBusContext = {}) =>
        create({
          logger:
            other === undefined
              ? context.logger
              : checkLogger('withContext()', other),
          metadata: {
            ...context.metadata,
            ...checkMetadata('withContext()', metadata),
          },
        }),
    })
  }

  return create({ logger, metadata: {} })
}
