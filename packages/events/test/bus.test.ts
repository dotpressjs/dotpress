import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createEventBus,
  createMemoryTransport,
  createSyncTransport,
  defineEvent,
  defineListener,
  EventEmitError,
  EventPayloadError,
  EventsError,
  PartialSendError,
  type Envelope,
} from '../src/index.js'
import { messageId } from '../src/envelope.js'
import {
  createLogger,
  createRecordingTransport,
  userCreated,
  recordingUploaded,
} from './support.js'

const welcome = defineListener(userCreated, {
  name: 'send-welcome-mail',
  handle: () => {},
})
const geocode = defineListener(userCreated, {
  name: 'geocode-user',
  handle: () => {},
})
const invalidate = defineListener(userCreated, {
  name: 'invalidate-cache',
  transport: 'edge' as never,
  handle: () => {},
})
const transcribe = defineListener(recordingUploaded, {
  name: 'transcribe',
  handle: () => {},
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createEventBus()', () => {
  it.each([
    ['not an object', null, 'createEventBus(): expected an object of options.'],
    [
      'an unknown option',
      { transport: createRecordingTransport(), listeners: [], queue: 'x' },
      'createEventBus(): unknown option "queue".',
    ],
    [
      'no transport',
      { listeners: [] },
      'createEventBus(): set exactly one of transport and transports.',
    ],
    [
      'transport and transports',
      {
        listeners: [],
        transport: createRecordingTransport(),
        transports: {},
      },
      'createEventBus(): set exactly one of transport and transports.',
    ],
    [
      'transports that are not an object',
      { listeners: [], transports: 'sqs' },
      'createEventBus(): transports must be an object.',
    ],
    [
      'a transport without send()',
      { listeners: [], transport: { kind: 'x' } },
      'createEventBus(): the "default" transport must have a kind and a send() method.',
    ],
    [
      'a transport without kind',
      { listeners: [], transports: { edge: { send: () => {} } } },
      'createEventBus(): the "edge" transport must have a kind and a send() method.',
    ],
    [
      'listeners that are not a list',
      { transport: createRecordingTransport() },
      'createEventBus(): listeners must be a list.',
    ],
    [
      'a listener routed to a missing transport',
      {
        transport: createRecordingTransport(),
        listeners: [welcome, invalidate],
      },
      'createEventBus(): listener "invalidate-cache" (event "user.created") uses the "edge" transport, which is not configured.',
    ],
    [
      'an event routed to a missing transport',
      {
        transports: { default: createRecordingTransport() },
        listeners: [transcribe],
      },
      'createEventBus(): listener "transcribe" (event "recording.uploaded") uses the "edge" transport, which is not configured.',
    ],
    [
      'no default transport',
      {
        transports: { edge: createRecordingTransport() },
        listeners: [welcome],
      },
      'createEventBus(): listener "send-welcome-mail" (event "user.created") uses the "default" transport, which is not configured.',
    ],
    [
      'an invalid logger',
      { transport: createRecordingTransport(), listeners: [], logger: {} },
      'createEventBus(): logger must have info(), warn() and error() methods.',
    ],
    [
      'an invalid onFailure',
      { transport: createRecordingTransport(), listeners: [], onFailure: 1 },
      'createEventBus(): onFailure must be a function.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createEventBus(options as never)).toThrow(
      new TypeError(message)
    )
  })

  it('accepts transports without listeners', () => {
    expect(() =>
      createEventBus({
        transports: {
          default: createRecordingTransport(),
          edge: undefined,
        } as never,
        listeners: [],
      })
    ).not.toThrow()
  })
})

describe('emit()', () => {
  it('sends one message per listener to its transport', async () => {
    const aws = createRecordingTransport('sqs')
    const edge = createRecordingTransport('cloudflare')
    const logger = createLogger()
    const events = createEventBus({
      transports: { default: aws, edge } as never,
      listeners: [welcome, geocode, invalidate, transcribe],
      logger,
    })

    const result = await events.emit(
      userCreated,
      { userId: '42' },
      { metadata: { source: 'import' } }
    )

    expect(result.emissionId).toMatch(/^[0-9a-f-]{36}$/)
    const ids = {
      welcome: await messageId(result.emissionId, 'send-welcome-mail'),
      geocode: await messageId(result.emissionId, 'geocode-user'),
      invalidate: await messageId(result.emissionId, 'invalidate-cache'),
    }
    expect(result.messages).toEqual([
      { id: ids.welcome, listener: 'send-welcome-mail', transport: 'default' },
      {
        id: ids.geocode,
        listener: 'geocode-user',
        transport: 'default',
      },
      { id: ids.invalidate, listener: 'invalidate-cache', transport: 'edge' },
    ])

    const base = {
      v: 1,
      emissionId: result.emissionId,
      event: 'user.created',
      payload: { userId: '42' },
      emittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      metadata: { source: 'import' },
    }
    expect(aws.sent).toEqual([
      {
        delay: undefined,
        envelopes: [
          { ...base, id: ids.welcome, listener: 'send-welcome-mail' },
          { ...base, id: ids.geocode, listener: 'geocode-user' },
        ],
      },
    ])
    expect(edge.sent).toEqual([
      {
        delay: undefined,
        envelopes: [
          { ...base, id: ids.invalidate, listener: 'invalidate-cache' },
        ],
      },
    ])
    expect(logger.entries).toEqual([
      {
        level: 'info',
        message: 'Event emitted',
        data: {
          event: 'user.created',
          emissionId: result.emissionId,
          messages: 3,
        },
      },
    ])
  })

  it('uses the transport of the event', async () => {
    const aws = createRecordingTransport()
    const edge = createRecordingTransport()
    const events = createEventBus({
      transports: { default: aws, edge } as never,
      listeners: [transcribe],
    })
    await events.emit(recordingUploaded, { recordingId: 'r1', size: 3 })
    expect(aws.send).not.toHaveBeenCalled()
    expect(edge.send).toHaveBeenCalledOnce()
  })

  it('passes the delay', async () => {
    const transport = createRecordingTransport()
    const events = createEventBus({ transport, listeners: [welcome] })
    await events.emit(userCreated, { userId: '42' }, { delay: 0 })
    await events.emit(userCreated, { userId: '42' }, { delay: 900 })
    expect(transport.sent.map(({ delay }) => delay)).toEqual([0, 900])
  })

  it('does nothing without listeners', async () => {
    const transport = createRecordingTransport()
    const logger = createLogger()
    const events = createEventBus({ transport, listeners: [], logger })
    const result = await events.emit(userCreated, {
      userId: '1',
    })
    expect(result).toEqual({ emissionId: expect.any(String), messages: [] })
    expect(transport.send).not.toHaveBeenCalled()
    expect(logger.entries).toEqual([
      {
        level: 'debug',
        message: 'Event emitted without listeners',
        data: { event: 'user.created', emissionId: result.emissionId },
      },
    ])
  })

  it('gives each emission its own identifiers', async () => {
    const events = createEventBus({
      transport: createRecordingTransport(),
      listeners: [welcome],
    })
    const first = await events.emit(userCreated, {
      userId: '1',
    })
    const second = await events.emit(userCreated, {
      userId: '1',
    })
    expect(first.emissionId).not.toBe(second.emissionId)
    expect(first.messages[0]?.id).not.toBe(second.messages[0]?.id)
  })

  it('derives the identifiers from the given emissionId', async () => {
    const transport = createRecordingTransport()
    const events = createEventBus({ transport, listeners: [welcome, geocode] })
    const emissionId = 'user-created:42'
    const first = await events.emit(
      userCreated,
      { userId: '42' },
      { emissionId }
    )
    const second = await events.emit(
      userCreated,
      { userId: '42' },
      { emissionId }
    )
    const ids = [
      await messageId(emissionId, 'send-welcome-mail'),
      await messageId(emissionId, 'geocode-user'),
    ]
    expect(first.emissionId).toBe(emissionId)
    expect(first.messages.map(({ id }) => id)).toEqual(ids)
    expect(second).toEqual(first)
    expect(ids[0]).not.toBe(ids[1])
    expect(
      transport.sent.flatMap(({ envelopes }) =>
        envelopes.map((envelope) => [envelope.emissionId, envelope.id])
      )
    ).toEqual([
      [emissionId, ids[0]],
      [emissionId, ids[1]],
      [emissionId, ids[0]],
      [emissionId, ids[1]],
    ])
  })

  it('returns the given emissionId without listeners', async () => {
    const events = createEventBus({
      transport: createRecordingTransport(),
      listeners: [],
    })
    await expect(
      events.emit(userCreated, { userId: '1' }, { emissionId: 'import:7' })
    ).resolves.toEqual({ emissionId: 'import:7', messages: [] })
  })

  describe('payload', () => {
    const event = defineEvent({
      name: 'invoice.paid',
      schema: z.object({
        amount: z.number().transform((value) => value * 100),
        note: z.string().optional(),
      }),
    })
    const listener = defineListener(event, { name: 'record', handle: () => {} })

    it('sends the payload as JSON, before parsing', async () => {
      const transport = createRecordingTransport()
      const events = createEventBus({ transport, listeners: [listener] })
      await events.emit(event, { amount: 12, note: undefined })
      // The transform runs in the worker, once.
      expect(transport.sent[0]?.envelopes[0]?.payload).toStrictEqual({
        amount: 12,
      })
    })

    it('rejects an invalid payload', async () => {
      const transport = createRecordingTransport()
      const events = createEventBus({ transport, listeners: [listener] })
      const error = await events
        .emit(event, { amount: '12' } as never)
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(EventPayloadError)
      expect(error).toBeInstanceOf(EventsError)
      expect(error).toMatchObject({
        name: 'EventPayloadError',
        event: 'invoice.paid',
        issues: [{ path: ['amount'], message: expect.any(String) }],
      })
      expect((error as Error).message).toMatch(
        /^Invalid payload for event "invoice\.paid": amount: /
      )
      expect(transport.send).not.toHaveBeenCalled()
    })

    it('rejects values that do not survive JSON', async () => {
      const dated = defineEvent({
        name: 'reminder.due',
        schema: z.object({ at: z.date() }),
      })
      const events = createEventBus({
        transport: createRecordingTransport(),
        listeners: [
          defineListener(dated, { name: 'remind', handle: () => {} }),
        ],
      })
      // A Date becomes a string: the listener would reject it.
      await expect(events.emit(dated, { at: new Date() })).rejects.toThrow(
        /^Invalid payload for event "reminder\.due": at: Invalid input: expected date, received string$/
      )
    })

    it('rejects payloads that cannot be serialized', async () => {
      const loose = defineEvent({ name: 'loose', schema: z.any() })
      const events = createEventBus({
        transport: createRecordingTransport(),
        listeners: [defineListener(loose, { name: 'a', handle: () => {} })],
      })
      const error = await events.emit(loose, { n: 1n }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(EventPayloadError)
      expect((error as Error).message).toMatch(
        /^Invalid payload for event "loose": the payload cannot be serialized as JSON \(.*BigInt/
      )
      // undefined becomes null.
      await expect(events.emit(loose, undefined)).resolves.toBeDefined()
    })

    it('reports symbol keys of paths', async () => {
      const key = Symbol('key')
      const symbolic = defineEvent({
        name: 'symbolic',
        schema: z.object({}).superRefine((_, ctx) => {
          ctx.addIssue({ code: 'custom', message: 'bad', path: [key] })
        }),
      })
      const events = createEventBus({
        transport: createRecordingTransport(),
        listeners: [],
      })
      await expect(events.emit(symbolic, {})).rejects.toMatchObject({
        issues: [{ path: ['Symbol(key)'], message: 'bad' }],
      })
    })
  })

  describe('options', () => {
    const events = createEventBus({
      transport: createRecordingTransport(),
      listeners: [welcome],
    })

    it('rejects a value that is not an event', async () => {
      await expect(
        events.emit({ name: 'user.created' } as never, {} as never)
      ).rejects.toThrow(
        new TypeError('emit(): expected an event created by defineEvent().')
      )
    })

    it.each([
      [{ delay: -1 }, 'delay must be a non-negative integer (seconds).'],
      [{ delay: 1.5 }, 'delay must be a non-negative integer (seconds).'],
      [{ delay: '60' }, 'delay must be a non-negative integer (seconds).'],
      [{ metadata: 'x' }, 'metadata must be an object.'],
      [{ metadata: [] }, 'metadata must be an object.'],
      [{ metadata: null }, 'metadata must be an object.'],
      [
        { metadata: { 'user id': '1' } },
        'metadata keys must have 1 to 128 letters, digits, ".", "_" or "-": "user id".',
      ],
      [{ metadata: { a: 1 } }, 'metadata.a must be a string on one line.'],
      [{ metadata: { a: 'x\ny' } }, 'metadata.a must be a string on one line.'],
      ...[42, '', 'x'.repeat(201), 'a\nb', 'a\u0000b', 'a\u007fb'].map(
        (emissionId): [object, string] => [
          { emissionId },
          'emissionId must be a string of 1 to 200 characters, without control characters.',
        ]
      ),
    ])('rejects %j', async (options, message) => {
      await expect(
        events.emit(userCreated, { userId: '1' }, options as never)
      ).rejects.toThrow(new TypeError(`emit("user.created"): ${message}`))
    })

    it('accepts emission ids up to 200 characters', async () => {
      for (const emissionId of ['a', 'x'.repeat(200), 'order:42 · ü 🎉']) {
        await expect(
          events.emit(userCreated, { userId: '1' }, { emissionId })
        ).resolves.toMatchObject({ emissionId })
      }
    })

    it('accepts no options', async () => {
      await expect(
        events.emit(userCreated, { userId: '1' }, undefined)
      ).resolves.toBeDefined()
      await expect(
        events.emit(userCreated, { userId: '1' }, null as never)
      ).resolves.toBeDefined()
    })
  })

  describe('send failures', () => {
    it('reports the messages that were not sent', async () => {
      const failure = new Error('SQS unavailable')
      const aws = createRecordingTransport()
      aws.send.mockRejectedValueOnce(failure)
      const edge = createRecordingTransport()
      const logger = createLogger()
      const events = createEventBus({
        transports: { default: aws, edge } as never,
        listeners: [welcome, geocode, invalidate],
        logger,
      })

      const error = await events
        .emit(userCreated, { userId: '42' })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(EventEmitError)
      expect(error).toMatchObject({
        name: 'EventEmitError',
        event: 'user.created',
        message:
          'Event "user.created" not fully emitted: 2 of 3 messages failed (send-welcome-mail, geocode-user): SQS unavailable',
        cause: failure,
        sent: [{ listener: 'invalidate-cache', transport: 'edge' }],
        failed: [
          {
            listener: 'send-welcome-mail',
            transport: 'default',
            error: failure,
          },
          {
            listener: 'geocode-user',
            transport: 'default',
            error: failure,
          },
        ],
      })
      expect(logger.entries).toEqual([])
    })

    it('reports partial failures of a transport', async () => {
      const transport = createRecordingTransport()
      const failure = new Error('throttled')
      transport.send.mockImplementationOnce(async (envelopes) => {
        throw new PartialSendError([
          { id: (envelopes[1] as Envelope).id, error: failure },
        ])
      })
      const events = createEventBus({
        transport,
        listeners: [welcome, geocode],
      })
      const error = (await events
        .emit(userCreated, { userId: '42' })
        .catch((e: unknown) => e)) as EventEmitError
      expect(error.sent.map(({ listener }) => listener)).toEqual([
        'send-welcome-mail',
      ])
      expect(error.failed).toEqual([
        expect.objectContaining({
          listener: 'geocode-user',
          error: failure,
        }),
      ])
      expect(error.message).toBe(
        'Event "user.created" not fully emitted: 1 of 2 messages failed (geocode-user): throttled'
      )
    })

    it('describes failures that are not errors', async () => {
      const transport = createRecordingTransport()
      transport.send.mockRejectedValueOnce('timeout')
      const events = createEventBus({ transport, listeners: [welcome] })
      await expect(events.emit(userCreated, { userId: '42' })).rejects.toThrow(
        /: timeout$/
      )
    })

    it('describes a partial send error', () => {
      expect(new PartialSendError([]).message).toBe('0 messages not sent.')
    })
  })

  describe('retry()', () => {
    it('sends the failed messages again, and only them', async () => {
      const aws = createRecordingTransport()
      aws.send.mockRejectedValueOnce(new Error('SQS unavailable'))
      const edge = createRecordingTransport()
      const logger = createLogger()
      const events = createEventBus({
        transports: { default: aws, edge } as never,
        listeners: [welcome, geocode, invalidate],
        logger,
      })
      const error = (await events
        .emit(
          userCreated,
          { userId: '42' },
          { delay: 30, metadata: { source: 'import' } }
        )
        .catch((e: unknown) => e)) as EventEmitError

      const result = await error.retry()
      const [failedCall, retryCall] = aws.send.mock.calls
      expect(retryCall).toEqual(failedCall)
      expect(retryCall?.[1]).toEqual({ delay: 30 })
      expect(retryCall?.[0].map(({ listener }) => listener)).toEqual([
        'send-welcome-mail',
        'geocode-user',
      ])
      expect(edge.send).toHaveBeenCalledOnce()
      expect(result).toEqual({
        emissionId: retryCall?.[0][0]?.emissionId,
        messages: [
          expect.objectContaining({ listener: 'send-welcome-mail' }),
          expect.objectContaining({ listener: 'geocode-user' }),
          expect.objectContaining({ listener: 'invalidate-cache' }),
        ],
      })
      expect(result.messages.map(({ id }) => id)).toEqual([
        ...error.failed.map(({ id }) => id),
        ...error.sent.map(({ id }) => id),
      ])
      expect(logger.entries).toEqual([
        {
          level: 'info',
          message: 'Event emitted',
          data: {
            event: 'user.created',
            emissionId: result.emissionId,
            messages: 3,
          },
        },
      ])
    })

    it('throws a new error that adds up the sent messages', async () => {
      const transport = createRecordingTransport()
      const edge = createRecordingTransport()
      transport.send.mockRejectedValueOnce(new Error('down'))
      transport.send.mockImplementationOnce(async (envelopes) => {
        throw new PartialSendError([
          { id: (envelopes[1] as Envelope).id, error: new Error('throttled') },
        ])
      })
      const events = createEventBus({
        transports: { default: transport, edge } as never,
        listeners: [welcome, geocode, invalidate],
      })
      const first = (await events
        .emit(userCreated, { userId: '42' })
        .catch((e: unknown) => e)) as EventEmitError
      const second = (await first
        .retry()
        .catch((e: unknown) => e)) as EventEmitError

      expect(second).toBeInstanceOf(EventEmitError)
      expect(second).not.toBe(first)
      const listeners = (refs: readonly { listener: string }[]) =>
        refs.map(({ listener }) => listener)
      expect(listeners(second.sent)).toEqual([
        'send-welcome-mail',
        'invalidate-cache',
      ])
      expect(listeners(second.failed)).toEqual(['geocode-user'])
      expect(second.message).toBe(
        'Event "user.created" not fully emitted: 1 of 3 messages failed (geocode-user): throttled'
      )

      const result = await second.retry()
      expect(listeners(result.messages)).toEqual([
        'send-welcome-mail',
        'geocode-user',
        'invalidate-cache',
      ])
      expect(
        transport.send.mock.calls.map(([envelopes]) => listeners(envelopes))
      ).toEqual([
        ['send-welcome-mail', 'geocode-user'],
        ['send-welcome-mail', 'geocode-user'],
        ['geocode-user'],
      ])
      expect(edge.send).toHaveBeenCalledOnce()
    })

    it('keeps the payload out of the error', async () => {
      const transport = createRecordingTransport()
      transport.send.mockRejectedValueOnce(new Error('down'))
      const events = createEventBus({ transport, listeners: [welcome] })
      const error = (await events
        .emit(userCreated, { userId: 'secret-user' })
        .catch((e: unknown) => e)) as EventEmitError
      expect(JSON.stringify(error)).not.toContain('secret-user')
      expect(inspect(error, { depth: Infinity })).not.toContain('secret-user')
      expect(Object.keys(error).sort()).toEqual([
        'event',
        'failed',
        'name',
        'sent',
      ])
      await expect(error.retry()).resolves.toMatchObject({
        messages: [{ listener: 'send-welcome-mail' }],
      })
    })

    it('cannot retry an error not thrown by emit()', async () => {
      const error = new EventEmitError('user.created', [], [])
      await expect(error.retry()).rejects.toThrow(
        new EventsError(
          'Event "user.created": this EventEmitError was not thrown by emit(), it cannot be retried.'
        )
      )
    })
  })

  describe('withContext()', () => {
    it('adds metadata and uses another logger', async () => {
      const transport = createRecordingTransport()
      const base = createLogger()
      const scoped = createLogger()
      const events = createEventBus({
        transport,
        listeners: [welcome],
        logger: base,
      })
      const request = events
        .withContext({ logger: scoped, metadata: { requestId: 'req-1' } })
        .withContext({ metadata: { actorId: '7' } })

      await request.emit(
        userCreated,
        { userId: '42' },
        { metadata: { actorId: '8' } }
      )
      expect(transport.sent[0]?.envelopes[0]?.metadata).toEqual({
        requestId: 'req-1',
        actorId: '8',
      })
      expect(scoped.entries).toHaveLength(1)
      expect(base.entries).toHaveLength(0)

      await events.withContext({}).emit(userCreated, { userId: '1' })
      expect(transport.sent[1]?.envelopes[0]?.metadata).toEqual({})
      expect(base.entries).toHaveLength(1)
      expect(Object.isFrozen(request)).toBe(true)
    })

    it('rejects invalid context', () => {
      const events = createEventBus({
        transport: createRecordingTransport(),
        listeners: [],
      })
      expect(() => events.withContext({ logger: {} as never })).toThrow(
        'withContext(): logger must have info(), warn() and error() methods.'
      )
      expect(() => events.withContext({ metadata: { a: 1 } as never })).toThrow(
        'withContext(): metadata.a must be a string on one line.'
      )
      expect(() => events.withContext(undefined as never)).not.toThrow()
    })
  })
})

describe('sync transport', () => {
  it('runs the listeners inside emit()', async () => {
    const calls: string[] = []
    const events = createEventBus({
      transport: createSyncTransport(),
      listeners: [
        defineListener(userCreated, {
          name: 'a',
          handle: ({ payload, attempt }) => {
            calls.push(`a:${payload.userId}:${attempt}`)
          },
        }),
        defineListener(userCreated, {
          name: 'b',
          handle: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            calls.push('b')
          },
        }),
      ],
    })
    await events.emit(userCreated, { userId: '42' }, { delay: 60 })
    calls.push('emitted')
    expect(calls).toEqual(['a:42:1', 'b', 'emitted'])
  })

  it('throws when a listener fails, after running the others', async () => {
    const failure = new Error('boom')
    const onFailure = vi.fn()
    const ran: string[] = []
    const events = createEventBus({
      transport: createSyncTransport(),
      onFailure,
      listeners: [
        defineListener(userCreated, {
          name: 'failing',
          handle: () => {
            throw failure
          },
        }),
        defineListener(userCreated, {
          name: 'working',
          handle: () => void ran.push('working'),
        }),
      ],
    })
    const error = (await events
      .emit(userCreated, { userId: '42' })
      .catch((e: unknown) => e)) as EventEmitError
    expect(error).toBeInstanceOf(EventEmitError)
    expect(error.cause).toBe(failure)
    expect(error.sent.map(({ listener }) => listener)).toEqual(['working'])
    expect(ran).toEqual(['working'])
    expect(onFailure).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        attempt: 1,
        final: true,
      })
    )
  })

  it('runs only the failed listeners on retry()', async () => {
    const ran: string[] = []
    let down = true
    const events = createEventBus({
      transport: createSyncTransport(),
      listeners: [
        defineListener(userCreated, {
          name: 'flaky',
          handle: () => {
            ran.push('flaky')
            if (down) throw new Error('down')
          },
        }),
        defineListener(userCreated, {
          name: 'working',
          handle: () => void ran.push('working'),
        }),
      ],
    })
    const error = (await events
      .emit(userCreated, { userId: '42' })
      .catch((e: unknown) => e)) as EventEmitError
    down = false
    const result = await error.retry()
    expect(ran).toEqual(['flaky', 'working', 'flaky'])
    expect(result.messages.map(({ listener }) => listener)).toEqual([
      'flaky',
      'working',
    ])
  })

  it('fails without a bus', async () => {
    await expect(
      createSyncTransport().send([], { delay: undefined })
    ).rejects.toThrow('The sync transport is not used by an event bus.')
  })

  it('reports messages that can never be handled', async () => {
    const transport = createSyncTransport()
    createEventBus({ transport, listeners: [welcome] })
    const envelope = { ...((await sample()) as Envelope), listener: 'unknown' }
    const error = (await transport
      .send([envelope], { delay: undefined })
      .catch((e: unknown) => e)) as PartialSendError
    expect(error).toBeInstanceOf(PartialSendError)
    expect(error.failed).toEqual([
      { id: envelope.id, error: expect.any(Error) },
    ])
  })
})

describe('memory transport', () => {
  it('runs the listeners after emit()', async () => {
    const calls: string[] = []
    const transport = createMemoryTransport()
    const events = createEventBus({
      transport,
      listeners: [
        defineListener(userCreated, {
          name: 'a',
          handle: ({ payload }) => void calls.push(payload.userId),
        }),
      ],
    })
    await events.emit(userCreated, { userId: '42' })
    calls.push('emitted')
    await transport.drain()
    expect(calls).toEqual(['emitted', '42'])
    expect(transport.kind).toBe('memory')
    expect(transport.sent).toEqual([
      expect.objectContaining({
        listener: 'a',
        payload: { userId: '42' },
      }),
    ])
    transport.clear()
    expect(transport.sent).toEqual([])
    await transport.drain()
  })

  it('retries failed listeners, with a growing delay', async () => {
    vi.useFakeTimers()
    const attempts: number[] = []
    const onFailure = vi.fn()
    const transport = createMemoryTransport()
    const events = createEventBus({
      transport,
      onFailure,
      listeners: [
        defineListener(userCreated, {
          name: 'flaky',
          handle: ({ attempt }) => {
            attempts.push(attempt)
            throw new Error('down')
          },
        }),
      ],
    })
    await events.emit(userCreated, { userId: '42' })
    const drained = transport.drain()
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toEqual([1])
    await vi.advanceTimersByTimeAsync(99)
    expect(attempts).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toEqual([1, 2])
    await vi.advanceTimersByTimeAsync(200)
    expect(attempts).toEqual([1, 2, 3])
    await vi.advanceTimersByTimeAsync(10_000)
    await drained
    expect(attempts).toEqual([1, 2, 3])
    expect(onFailure.mock.calls.map(([, info]) => info.final)).toEqual([
      false,
      false,
      true,
    ])
  })

  it('stops retrying after a success', async () => {
    let calls = 0
    const transport = createMemoryTransport({
      maxAttempts: 5,
      retryDelay: () => 0,
    })
    const events = createEventBus({
      transport,
      listeners: [
        defineListener(userCreated, {
          name: 'flaky',
          handle: () => {
            calls += 1
            if (calls < 2) throw new Error('down')
          },
        }),
      ],
    })
    await events.emit(userCreated, { userId: '42' })
    await transport.drain()
    expect(calls).toBe(2)
  })

  it('only runs the listeners routed to it', async () => {
    const transport = createMemoryTransport({ retryDelay: () => 0 })
    const onFailure = vi.fn()
    createEventBus({
      transports: {
        default: transport,
        edge: createRecordingTransport(),
      } as never,
      listeners: [welcome, invalidate],
      onFailure,
    })
    await transport.send(
      [{ ...((await sample()) as Envelope), listener: 'invalidate-cache' }],
      { delay: undefined }
    )
    await transport.drain()
    expect(onFailure.mock.calls[0]?.[1]).toMatchObject({
      reason: 'unknown-listener',
    })
  })

  it('does not retry dead messages', async () => {
    const transport = createMemoryTransport({ retryDelay: () => 0 })
    const onFailure = vi.fn()
    createEventBus({ transport, listeners: [welcome], onFailure })
    await transport.send(
      [{ ...((await sample()) as Envelope), listener: 'unknown' }],
      { delay: undefined }
    )
    await transport.drain()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure.mock.calls[0]?.[1]).toMatchObject({
      reason: 'unknown-listener',
      final: true,
    })
  })

  it('delays messages', async () => {
    vi.useFakeTimers()
    const calls: number[] = []
    const transport = createMemoryTransport()
    const events = createEventBus({
      transport,
      listeners: [
        defineListener(userCreated, {
          name: 'a',
          handle: () => void calls.push(Date.now()),
        }),
      ],
    })
    const start = Date.now()
    await events.emit(userCreated, { userId: '1' }, { delay: 2 })
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual([start + 2000])
  })

  it.each([
    [
      { maxAttempts: 0 },
      'createMemoryTransport(): maxAttempts must be a positive integer.',
    ],
    [
      { maxAttempts: 1.5 },
      'createMemoryTransport(): maxAttempts must be a positive integer.',
    ],
    [
      { retryDelay: 100 },
      'createMemoryTransport(): retryDelay must be a function.',
    ],
  ])('rejects %j', (options, message) => {
    expect(() => createMemoryTransport(options as never)).toThrow(
      new TypeError(message)
    )
  })

  it('accepts no options', () => {
    expect(createMemoryTransport(undefined).maxAttempts).toBe(3)
    expect(createMemoryTransport(null as never).maxAttempts).toBe(3)
  })

  it('fails without a bus', async () => {
    await expect(
      createMemoryTransport().send([], { delay: undefined })
    ).rejects.toThrow('The memory transport is not used by an event bus.')
  })
})

/** An envelope emitted by a recording bus. */
const sample = async () => {
  const transport = createRecordingTransport()
  await createEventBus({ transport, listeners: [welcome] }).emit(userCreated, {
    userId: '1',
  })
  return transport.sent[0]?.envelopes[0]
}
