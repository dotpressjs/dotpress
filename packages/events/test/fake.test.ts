import { expectEventEmitted, expectEventNotEmitted } from '@dotpress/testing'
import { describe, expect, it } from 'vitest'
import {
  createEventBus,
  createFakeEventBus,
  createMemoryTransport,
  defineListener,
  EventPayloadError,
} from '../src/index.js'
import { createLogger, userCreated } from './support.js'

describe('createFakeEventBus()', () => {
  it('records emissions without running listeners', async () => {
    const events = createFakeEventBus()
    const result = await events.emit(
      userCreated,
      { userId: '42' },
      { delay: 30, metadata: { source: 'import' } }
    )
    expect(result).toEqual({ emissionId: expect.any(String), messages: [] })
    expect(events.emitted).toEqual([
      {
        emissionId: result.emissionId,
        event: 'user.created',
        payload: { userId: '42' },
        delay: 30,
        metadata: { source: 'import' },
        emittedAt: expect.any(Date),
      },
    ])
    expect(Object.isFrozen(events.emitted[0])).toBe(true)
    expect(Object.isFrozen(events.emitted[0]?.metadata)).toBe(true)
    expect(Object.isFrozen(events)).toBe(true)
  })

  it('checks emissions like a real bus', async () => {
    const events = createFakeEventBus()
    await expect(
      events.emit(userCreated, { userId: 42 } as never)
    ).rejects.toBeInstanceOf(EventPayloadError)
    await expect(
      events.emit({ name: 'x' } as never, {} as never)
    ).rejects.toThrow('emit(): expected an event created by defineEvent().')
    await expect(
      events.emit(userCreated, { userId: '42' }, { delay: -1 })
    ).rejects.toThrow('delay must be a non-negative integer (seconds).')
    await expect(
      events.emit(
        userCreated,
        { userId: '42' },
        { metadata: { 'bad key': 'x' } }
      )
    ).rejects.toThrow('metadata keys must have')
    expect(events.emitted).toEqual([])
  })

  it('records the given emissionId', async () => {
    const events = createFakeEventBus()
    const result = await events.emit(
      userCreated,
      { userId: '42' },
      { emissionId: 'user-created:42' }
    )
    expect(result.emissionId).toBe('user-created:42')
    expect(events.emitted[0]?.emissionId).toBe('user-created:42')
    await expect(
      events.emit(userCreated, { userId: '42' }, { emissionId: '' })
    ).rejects.toThrow(
      'emit("user.created"): emissionId must be a string of 1 to 200 characters, without control characters.'
    )
    expect(events.emitted).toHaveLength(1)
  })

  it('records the payload after JSON', async () => {
    const events = createFakeEventBus()
    await events.emit(userCreated, {
      userId: '42',
      extra: undefined,
    } as never)
    expect(events.emitted[0]?.payload).toStrictEqual({ userId: '42' })
  })

  it('shares the record with its contexts, and merges their metadata', async () => {
    const events = createFakeEventBus()
    const scoped = events
      .withContext({ metadata: { requestId: 'req-1' } })
      .withContext({ logger: createLogger(), metadata: { tenant: 'acme' } })
    await scoped.emit(
      userCreated,
      { userId: '42' },
      { metadata: { tenant: 'other' } }
    )
    await events.withContext({}).emit(userCreated, { userId: '43' })
    expect(events.emitted.map(({ metadata }) => metadata)).toEqual([
      { requestId: 'req-1', tenant: 'other' },
      {},
    ])
    expect(() => events.withContext({ logger: {} as never })).toThrow(
      'withContext()'
    )
    expect(() =>
      events.withContext({ metadata: { requestId: 'a\nb' } })
    ).toThrow('withContext()')
    events.clear()
    expect(events.emitted).toEqual([])
  })

  it('works with the assertions of @dotpress/testing', async () => {
    const events = createFakeEventBus()
    await events
      .withContext({ metadata: { requestId: 'req-1' } })
      .emit(userCreated, { userId: '42' }, { delay: 60 })
    const emission = expectEventEmitted(
      events,
      userCreated,
      { userId: '42' },
      { metadata: { requestId: 'req-1' }, delay: 60, times: 1 }
    )
    expect(emission).toBe(events.emitted[0])
    expectEventNotEmitted(events, 'user.deleted')
  })

  it('lets the assertions read a memory transport', async () => {
    const transport = createMemoryTransport()
    const events = createEventBus({
      transport,
      listeners: ['a', 'b'].map((name) =>
        defineListener(userCreated, { name, handle: () => {} })
      ),
    })
    await events.emit(userCreated, { userId: '42' })
    await transport.drain()
    expectEventEmitted(
      transport,
      userCreated,
      { userId: '42' },
      {
        times: 1,
      }
    )
  })
})

describe('createEventBus() metadata', () => {
  it('checks the metadata of events without listeners', async () => {
    const events = createEventBus({
      transport: createMemoryTransport(),
      listeners: [],
    })
    await expect(
      events.emit(
        userCreated,
        { userId: '42' },
        { metadata: { requestId: 42 } as never }
      )
    ).rejects.toThrow('emit("user.created"): metadata')
  })
})
