import {
  checkEmission,
  checkMetadata,
  type EventBus,
  type EventBusContext,
} from './bus.js'
import { checkLogger } from './logger.js'

/** An emission recorded by a fake event bus. */
export interface RecordedEmission {
  readonly emissionId: string
  /** Name of the event. */
  readonly event: string
  /** Payload, as the listeners would receive it (after JSON). */
  readonly payload: unknown
  readonly delay: number | undefined
  /** Metadata of the emission, with the metadata of the context. */
  readonly metadata: Readonly<Record<string, string>>
  readonly emittedAt: Date
}

/** Event bus that records emissions instead of sending them, for tests. */
export interface FakeEventBus extends EventBus {
  /** Recorded emissions, oldest first, from this bus and its contexts. */
  readonly emitted: readonly RecordedEmission[]
  /** Forgets the recorded emissions. */
  clear(): void
}

/**
 * Creates an event bus that checks emissions like `createEventBus()` (event,
 * payload, emissionId, delay, metadata) and records them, without running listeners:
 * to test the code that emits, with `expectEventEmitted()` of
 * `@dotpress/testing`.
 *
 * ```ts
 * const events = createFakeEventBus()
 * await signUp(events, 'ada@example.com')
 * expect(events.emitted).toMatchObject([{ event: 'user.created' }])
 * ```
 */
export const createFakeEventBus = (): FakeEventBus => {
  const emitted: RecordedEmission[] = []

  const create = (metadata: Readonly<Record<string, string>>): EventBus => {
    const emit: EventBus['emit'] = async (event, payload, options) => {
      const checked = await checkEmission(event, payload, options, metadata)
      const emissionId = checked.emissionId ?? crypto.randomUUID()
      emitted.push(
        Object.freeze({
          emissionId,
          event: checked.event.name,
          payload: checked.json,
          delay: checked.delay,
          metadata: Object.freeze(checked.metadata),
          emittedAt: new Date(),
        })
      )
      return { emissionId, messages: [] }
    }
    return Object.freeze({
      emit,
      close: async () => {},
      withContext: ({ logger, metadata: added }: EventBusContext = {}) => {
        if (logger !== undefined) checkLogger('withContext()', logger)
        return create({
          ...metadata,
          ...checkMetadata('withContext()', added),
        })
      },
    })
  }

  const root = create({})
  return Object.freeze({
    ...root,
    emitted,
    clear: () => {
      emitted.length = 0
    },
  })
}
