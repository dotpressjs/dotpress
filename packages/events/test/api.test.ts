import { createApp, createRouter, parseDuration } from '@dotpress/core'
import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'
import { describe, expect, it, vi } from 'vitest'
import { toMilliseconds } from '../src/duration.js'
import {
  createEventBus,
  createSyncTransport,
  defineListener,
  type Transport,
} from '../src/index.js'
import { eventsPlugin } from '../src/plugin.js'
import { createWorker } from '../src/worker.js'
import {
  createLogger,
  createRecordingTransport,
  envelopeOf,
  userCreated,
} from './support.js'

const listener = defineListener(userCreated, {
  name: 'send-welcome-mail',
  handle: () => {},
})

describe('durations', () => {
  it('are parsed like the Duration of @dotpress/core', () => {
    for (const value of [
      0,
      30,
      0.5,
      0.0004,
      '500ms',
      '1.5s',
      '10m',
      '1h',
      '7d',
      -1,
      Number.NaN,
      '10',
      '1h30m',
      ' 1s',
      null,
    ]) {
      let core: unknown
      let events: unknown
      try {
        core = parseDuration(value)
      } catch (error) {
        core = (error as Error).message
      }
      try {
        events = toMilliseconds(value, 'Duration')
      } catch (error) {
        events = (error as Error).message
      }
      expect(events).toEqual(core)
    }
  })

  it('give emit() delays in whole seconds, rounded up', async () => {
    const transport = createRecordingTransport()
    const events = createEventBus({ transport, listeners: [listener] })

    await events.emit(userCreated, { userId: '1' }, { delay: '5m' })
    await events.emit(userCreated, { userId: '1' }, { delay: '500ms' })
    await events.emit(userCreated, { userId: '1' }, { delay: 0 })

    expect(transport.sent.map(({ delay }) => delay)).toEqual([300, 1, 0])
  })
})

describe('envelopes of a later version', () => {
  it('are retried, not dead-lettered', async () => {
    const onFailure = vi.fn()
    const worker = createWorker({
      listeners: [listener],
      logger: createLogger(),
      onFailure,
      maxAttempts: 3,
    })
    const next = { ...envelopeOf(), v: 2 }

    const first = await worker.handle(next, { attempt: 1 })
    expect(first).toMatchObject({ status: 'retry' })
    expect(onFailure).toHaveBeenLastCalledWith(expect.any(Error), {
      envelope: undefined,
      reason: 'unsupported-version',
      attempt: 1,
      final: false,
    })
    await worker.handle(next, { attempt: 3 })
    expect(onFailure.mock.calls[1]?.[1]).toMatchObject({ final: true })
  })
})

describe('bus.close()', () => {
  it('closes every transport once, then throws the first error', async () => {
    const closed: string[] = []
    const transportOf = (name: string, fails = false): Transport => ({
      kind: name,
      send: async () => {},
      close: async () => {
        closed.push(name)
        if (fails) throw new Error(`${name} down`)
      },
    })
    const shared = transportOf('shared')
    const events = createEventBus({
      transports: {
        default: shared,
        // The same transport under two names is closed once.
        other: shared,
        failing: transportOf('failing', true),
        plain: { kind: 'plain', send: async () => {} },
      } as never,
      listeners: [listener],
    })

    await expect(events.close()).rejects.toThrow('failing down')
    expect(closed.sort()).toEqual(['failing', 'shared'])
    // Once: closing again gives the same result.
    await expect(events.close()).rejects.toThrow('failing down')
    expect(closed).toHaveLength(2)
  })

  it('is called by eventsPlugin() when the app closes', async () => {
    const close = vi.fn(async () => {})
    const events = createEventBus({
      transport: { kind: 'closable', send: async () => {}, close },
      listeners: [listener],
    })
    const app = await createApp({
      adapter: memoryAdapter(),
      routers: [createRouter()],
      plugins: [eventsPlugin(events)],
      logger: createMemoryLogger(),
    })

    await app.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('leaves no internal hooks on the in-process transports', () => {
    const transport = createSyncTransport()
    expect(Object.keys(transport).sort()).toEqual(['kind', 'send'])
  })
})
