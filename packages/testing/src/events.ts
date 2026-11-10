import { assertCount, checkTimes, matches, show } from './assertions.js'

/** An emission, as recorded by `createFakeEventBus()` of `@dotpress/events`. */
export interface Emission {
  readonly emissionId: string
  readonly event: string
  readonly payload: unknown
  readonly delay: number | undefined
  readonly metadata: Readonly<Record<string, string>>
  readonly emittedAt: Date
}

/** The fields of an envelope read here (`Envelope` of `@dotpress/events`). */
interface EnvelopeLike {
  readonly emissionId: string
  readonly event: string
  readonly payload: unknown
  readonly metadata: Readonly<Record<string, string>>
  readonly emittedAt: string
}

/**
 * Where emissions are read: a fake event bus (`createFakeEventBus()`), or a
 * memory transport (`createMemoryTransport()`), which only sees the events
 * that have listeners on it.
 */
export type EmissionSource<E extends Emission = Emission> =
  | { readonly emitted: readonly E[] }
  | { readonly sent: readonly EnvelopeLike[] }

/** Options of `expectEventEmitted()`. */
export interface ExpectEventOptions {
  /** Exact number of matching emissions. Defaults to at least one. */
  times?: number | undefined
  /** Metadata of the emission, matched partially. */
  metadata?: Readonly<Record<string, unknown>> | undefined
  /** Delay of the emission, in seconds (fake event bus only). */
  delay?: number | undefined
}

const OPTIONS = ['times', 'metadata', 'delay']

/** Emissions of a source, oldest first. */
const emissionsOf = (label: string, source: unknown): Emission[] => {
  if (typeof source === 'object' && source !== null) {
    if ('emitted' in source && Array.isArray(source.emitted)) {
      return source.emitted as Emission[]
    }
    if ('sent' in source && Array.isArray(source.sent)) {
      // One envelope per listener: one emission per emissionId (the
      // envelopes of an emission share its fields).
      const emissions = new Map<string, Emission>()
      for (const envelope of source.sent as EnvelopeLike[]) {
        emissions.set(envelope.emissionId, {
          emissionId: envelope.emissionId,
          event: envelope.event,
          payload: envelope.payload,
          delay: undefined,
          metadata: envelope.metadata,
          emittedAt: new Date(envelope.emittedAt),
        })
      }
      return [...emissions.values()]
    }
  }
  throw new TypeError(
    `${label}: expected a fake event bus (createFakeEventBus()) or a memory transport (createMemoryTransport()).`
  )
}

const nameOf = (label: string, event: unknown): string => {
  const name =
    typeof event === 'string'
      ? event
      : (event as { name?: unknown } | null)?.name
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(
      `${label}: expected an event created by defineEvent(), or its name.`
    )
  }
  return name
}

const find = (
  label: string,
  source: unknown,
  event: unknown,
  payload: unknown,
  options: unknown
) => {
  const name = nameOf(label, event)
  if (
    options !== undefined &&
    (typeof options !== 'object' || options === null)
  ) {
    throw new TypeError(`${label}: expected an object of options.`)
  }
  const values = (options ?? {}) as ExpectEventOptions
  for (const key of Object.keys(values)) {
    if (!OPTIONS.includes(key)) {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  checkTimes(label, values.times)
  const emissions = emissionsOf(label, source)
  if ('delay' in values && !('emitted' in (source as object))) {
    throw new TypeError(
      `${label}: delay is only recorded by a fake event bus (createFakeEventBus()).`
    )
  }
  const found = emissions.filter(
    (emission) =>
      emission.event === name &&
      (payload === undefined || matches(emission.payload, payload)) &&
      (values.metadata === undefined ||
        matches(emission.metadata, values.metadata)) &&
      (!('delay' in values) || emission.delay === values.delay)
  )
  const details = [
    payload === undefined ? '' : ` with payload ${show(payload)}`,
    values.metadata === undefined
      ? ''
      : ` and metadata ${show(values.metadata)}`,
    'delay' in values ? ` and delay ${String(values.delay)}` : '',
  ].join('')
  const recorded =
    emissions.length === 0
      ? 'No event was emitted.'
      : `Emitted events:\n${emissions
          .map(
            (emission) =>
              `  - ${emission.event} ${show(emission.payload)}${emission.delay === undefined ? '' : ` (delay ${emission.delay})`}`
          )
          .join('\n')}`
  return {
    found,
    description: {
      some: `event "${name}" emitted${details}`,
      none: `no event "${name}" emitted${details}`,
    },
    recorded,
    times: values.times,
  }
}

/**
 * Asserts that an event was emitted, at least once or exactly `times`
 * times, with a payload (and metadata) matching the expected values:
 * objects are matched partially, and asymmetric matchers are accepted.
 * Without payload (or with `undefined`), any payload matches.
 * Returns the last matching emission.
 *
 * ```ts
 * const events = createFakeEventBus()
 * await signUp(events, 'ada@example.com')
 * expectEventEmitted(events, userCreated, { email: 'ada@example.com' })
 * ```
 */
export function expectEventEmitted<E extends Emission>(
  source: EmissionSource<E>,
  event: { readonly name: string } | string,
  ...rest: [payload?: unknown, options?: ExpectEventOptions]
): E {
  const label = 'expectEventEmitted()'
  const [payload, options] = rest
  const { found, description, recorded, times } = find(
    label,
    source,
    event,
    payload,
    options
  )
  if (times === 0) {
    throw new TypeError(
      `${label}: times must be at least 1 (use expectEventNotEmitted()).`
    )
  }
  assertCount(description, found.length, times, recorded)
  return found.at(-1) as E
}

/**
 * Asserts that an event was not emitted (with this payload, if given).
 *
 * ```ts
 * expectEventNotEmitted(events, userCreated)
 * ```
 */
export function expectEventNotEmitted(
  source: EmissionSource,
  event: { readonly name: string } | string,
  ...rest: [payload?: unknown]
): void {
  const label = 'expectEventNotEmitted()'
  const { found, description, recorded } = find(
    label,
    source,
    event,
    rest[0],
    undefined
  )
  assertCount(description, found.length, 0, recorded)
}
