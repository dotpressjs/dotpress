import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createWorker,
  defineEvent,
  defineListener,
  type ListenerContext,
} from '../src/index.js'
import { createLogger, envelopeOf, userCreated } from './support.js'

const setup = (
  handle: (context: ListenerContext<{ userId: string }>) => unknown = () =>
    undefined,
  options: Record<string, unknown> = {}
) => {
  const listener = defineListener(userCreated, {
    name: 'send-welcome-mail',
    handle: vi.fn(handle),
  })
  const logger = createLogger()
  const onFailure = vi.fn()
  const worker = createWorker({
    listeners: [listener],
    logger,
    onFailure,
    ...options,
  })
  return { worker, logger, onFailure, listener }
}

describe('createWorker()', () => {
  it('lists its listeners', () => {
    const { worker } = setup()
    expect(worker.listeners).toEqual(['send-welcome-mail'])
    expect(Object.isFrozen(worker)).toBe(true)
    expect(Object.isFrozen(worker.listeners)).toBe(true)
  })

  it.each([
    ['not an object', null, 'createWorker(): expected an object of options.'],
    [
      'an unknown option',
      { listeners: [], concurrency: 2 },
      'createWorker(): unknown option "concurrency".',
    ],
    ['no listeners', {}, 'createWorker(): listeners must be a list.'],
    [
      'a listener not created by defineListener()',
      { listeners: [{ name: 'a' }] },
      'createWorker(): listeners must be created by defineListener().',
    ],
    [
      'two listeners with the same name',
      {
        listeners: [
          defineListener(userCreated, { name: 'a', handle: () => {} }),
          defineListener(userCreated, { name: 'a', handle: () => {} }),
        ],
      },
      'createWorker(): two listeners are named "a".',
    ],
    [
      'an invalid logger',
      { listeners: [], logger: { info: () => {} } },
      'createWorker(): logger must have info(), warn() and error() methods.',
    ],
    [
      'an invalid onFailure',
      { listeners: [], onFailure: 'log' },
      'createWorker(): onFailure must be a function.',
    ],
    [
      'maxAttempts of 0',
      { listeners: [], maxAttempts: 0 },
      'createWorker(): maxAttempts must be a positive integer.',
    ],
    [
      'maxAttempts that is not an integer',
      { listeners: [], maxAttempts: 1.5 },
      'createWorker(): maxAttempts must be a positive integer.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createWorker(options as never)).toThrow(new TypeError(message))
  })
})

describe('worker.handle()', () => {
  it('runs the listener with its context', async () => {
    let received: ListenerContext<{ userId: string }> | undefined
    const { worker, logger, onFailure } = setup((context) => {
      received = context
    })
    expect(
      await worker.handle(JSON.stringify(envelopeOf()), { attempt: 2 })
    ).toEqual({
      status: 'success',
    })
    expect(received).toEqual({
      payload: { userId: '42' },
      event: 'user.created',
      listener: 'send-welcome-mail',
      id: '00000000-0000-8000-8000-000000000001',
      emissionId: 'emission-1',
      attempt: 2,
      emittedAt: new Date('2026-11-10T10:00:00.000Z'),
      metadata: { requestId: 'req-1' },
      logger,
    })
    expect(onFailure).not.toHaveBeenCalled()
    expect(logger.entries).toEqual([
      {
        level: 'debug',
        message: 'Event listener succeeded',
        data: {
          event: 'user.created',
          listener: 'send-welcome-mail',
          messageId: '00000000-0000-8000-8000-000000000001',
          attempt: 2,
        },
      },
    ])
  })

  it('counts the first attempt by default', async () => {
    let attempt = 0
    const { worker } = setup((context) => {
      attempt = context.attempt
    })
    await worker.handle(envelopeOf())
    expect(attempt).toBe(1)
  })

  it('works without logger nor onFailure', async () => {
    const listener = defineListener(userCreated, {
      name: 'send-welcome-mail',
      handle: () => {
        throw new Error('boom')
      },
    })
    const worker = createWorker({ listeners: [listener] })
    expect(await worker.handle(envelopeOf())).toMatchObject({ status: 'retry' })
    expect(await worker.handle('x')).toMatchObject({ status: 'dead' })
  })

  it('passes the parsed payload', async () => {
    const event = defineEvent({
      name: 'invoice.paid',
      schema: z.object({
        amount: z.string().transform(Number),
        paidAt: z.coerce.date(),
      }),
    })
    let payload: unknown
    const worker = createWorker({
      listeners: [
        defineListener(event, {
          name: 'record-payment',
          handle: (context) => {
            payload = context.payload
          },
        }),
      ],
    })
    await worker.handle(
      envelopeOf({
        event: 'invoice.paid',
        listener: 'record-payment',
        payload: { amount: '12.5', paidAt: '2026-11-10T10:00:00.000Z' },
      })
    )
    expect(payload).toEqual({
      amount: 12.5,
      paidAt: new Date('2026-11-10T10:00:00.000Z'),
    })
  })

  describe('failures', () => {
    it('asks to retry when the listener throws', async () => {
      const failure = new Error('SMTP down')
      const { worker, logger, onFailure } = setup(() => {
        throw failure
      })
      const result = await worker.handle(envelopeOf(), { attempt: 1 })
      expect(result).toEqual({ status: 'retry', error: failure })
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure, {
        envelope: envelopeOf(),
        reason: 'listener-error',
        attempt: 1,
        final: false,
      })
      expect(logger.entries).toEqual([
        {
          level: 'warn',
          message: 'Event listener failed, the message is retried',
          data: {
            event: 'user.created',
            listener: 'send-welcome-mail',
            messageId: '00000000-0000-8000-8000-000000000001',
            attempt: 1,
            reason: 'listener-error',
            error: 'SMTP down',
          },
        },
      ])
    })

    it('reports the last attempt as final', async () => {
      const { worker, logger, onFailure } = setup(
        () => {
          throw 'timeout'
        },
        { maxAttempts: 3 }
      )
      await worker.handle(envelopeOf(), { attempt: 2 })
      await worker.handle(envelopeOf(), { attempt: 3 })
      await worker.handle(envelopeOf(), { attempt: 4 })
      expect(onFailure.mock.calls.map(([, info]) => info.final)).toEqual([
        false,
        true,
        true,
      ])
      expect(logger.entries.map(({ level }) => level)).toEqual([
        'warn',
        'error',
        'error',
      ])
      expect(logger.entries[1]).toMatchObject({
        message: 'Event listener failed, the message is not retried',
        data: { error: 'timeout' },
      })
    })

    it('retries a schema refinement that throws', async () => {
      const failure = new Error('database down')
      const event = defineEvent({
        name: 'checked',
        schema: z.object({ id: z.string() }).refine(async () => {
          throw failure
        }),
      })
      const onFailure = vi.fn()
      const worker = createWorker({
        listeners: [defineListener(event, { name: 'a', handle: () => {} })],
        onFailure,
        maxAttempts: 2,
      })
      const envelope = envelopeOf({
        event: 'checked',
        listener: 'a',
        payload: { id: '1' },
      })
      expect(await worker.handle(envelope, { attempt: 2 })).toEqual({
        status: 'retry',
        error: failure,
      })
      expect(onFailure).toHaveBeenCalledWith(failure, {
        envelope,
        reason: 'listener-error',
        attempt: 2,
        final: true,
      })
    })

    it.each([
      [
        'a message that is not an envelope',
        'not json',
        'invalid-envelope',
        'Invalid message: the message is not JSON.',
        undefined,
      ],
      [
        'an unknown listener',
        envelopeOf({ listener: 'geocode' }),
        'unknown-listener',
        'Unknown listener "geocode": this worker runs send-welcome-mail.',
        envelopeOf({ listener: 'geocode' }),
      ],
      [
        'another event',
        envelopeOf({ event: 'order.placed' }),
        'invalid-envelope',
        'Listener "send-welcome-mail" listens to "user.created", not "order.placed".',
        envelopeOf({ event: 'order.placed' }),
      ],
      [
        'an invalid payload',
        envelopeOf({ payload: { userId: 42 } }),
        'invalid-payload',
        'Invalid payload for event "user.created": userId: Invalid input: expected string, received number',
        envelopeOf({ payload: { userId: 42 } }),
      ],
      [
        'a payload that is not an object',
        envelopeOf({ payload: 'x' }),
        'invalid-payload',
        'Invalid payload for event "user.created": Invalid input: expected object, received string',
        envelopeOf({ payload: 'x' }),
      ],
    ])('gives up on %s', async (_, message, reason, text, envelope) => {
      const { worker, logger, onFailure, listener } = setup()
      const result = await worker.handle(message, { attempt: 1 })
      expect(result).toMatchObject({ status: 'dead', reason })
      expect((result as { error: Error }).error.message).toBe(text)
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
        envelope,
        reason,
        attempt: 1,
        final: true,
      })
      expect(logger.entries).toEqual([
        {
          level: 'error',
          message: 'Event listener failed, the message is not retried',
          data: {
            event: envelope?.event,
            listener: envelope?.listener,
            messageId: envelope?.id,
            attempt: 1,
            reason,
            error: text,
          },
        },
      ])
      void listener
    })

    it('reports every issue of the payload', async () => {
      const event = defineEvent({
        name: 'invoice.paid',
        schema: z.object({ invoiceId: z.string(), amount: z.number() }),
      })
      const worker = createWorker({
        listeners: [
          defineListener(event, { name: 'record', handle: () => {} }),
        ],
      })
      const result = await worker.handle(
        envelopeOf({ event: 'invoice.paid', listener: 'record', payload: {} })
      )
      expect((result as { error: Error }).error.message).toBe(
        'Invalid payload for event "invoice.paid": invoiceId: Invalid input: expected string, received undefined; amount: Invalid input: expected number, received undefined'
      )
    })

    it('reports a worker without listeners', async () => {
      const worker = createWorker({ listeners: [] })
      const result = await worker.handle(envelopeOf())
      expect((result as { error: Error }).error.message).toBe(
        'Unknown listener "send-welcome-mail": this worker runs no listener.'
      )
    })

    it('logs the failures of onFailure', async () => {
      const { worker, logger } = setup(
        () => {
          throw new Error('boom')
        },
        {
          onFailure: () => {
            throw new Error('alerting down')
          },
        }
      )
      expect(await worker.handle(envelopeOf())).toMatchObject({
        status: 'retry',
      })
      expect(logger.entries[1]).toEqual({
        level: 'error',
        message: 'onFailure hook failed',
        data: expect.objectContaining({
          error: 'boom',
          hookError: 'alerting down',
        }),
      })
    })

    it('waits for an async onFailure', async () => {
      const calls: string[] = []
      const { worker } = setup(
        () => {
          throw new Error('boom')
        },
        {
          onFailure: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            calls.push('hook')
          },
        }
      )
      await worker.handle(envelopeOf())
      calls.push('handled')
      expect(calls).toEqual(['hook', 'handled'])
    })
  })

  describe('lazy listeners', () => {
    it('loads the handler once', async () => {
      const handler = vi.fn()
      const load = vi.fn(async () => ({ default: handler }))
      const worker = createWorker({
        listeners: [
          defineListener(userCreated, {
            name: 'send-welcome-mail',
            load,
          }),
        ],
      })
      expect(load).not.toHaveBeenCalled()
      await worker.handle(envelopeOf())
      await worker.handle(envelopeOf())
      expect(load).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledTimes(2)
    })

    it('loads again after a failure', async () => {
      const handler = vi.fn()
      const load = vi
        .fn<() => Promise<{ default: typeof handler }>>()
        .mockRejectedValueOnce(new Error('cannot find module'))
        .mockResolvedValue({ default: handler })
      const worker = createWorker({
        listeners: [
          defineListener(userCreated, {
            name: 'send-welcome-mail',
            load,
          }),
        ],
      })
      const first = await worker.handle(envelopeOf())
      expect(first).toMatchObject({ status: 'retry' })
      expect((first as { error: Error }).error.message).toBe(
        'cannot find module'
      )
      expect(await worker.handle(envelopeOf())).toEqual({ status: 'success' })
      expect(load).toHaveBeenCalledTimes(2)
    })

    it.each([
      ['no default export', {}],
      ['a default export that is not a function', { default: 'x' }],
      ['no module', null],
    ])('rejects a module with %s', async (_, module) => {
      const worker = createWorker({
        listeners: [
          defineListener(userCreated, {
            name: 'send-welcome-mail',
            load: async () => module as never,
          }),
        ],
      })
      const result = await worker.handle(envelopeOf())
      expect(result).toMatchObject({ status: 'retry' })
      expect((result as { error: Error }).error.message).toBe(
        'Listener "send-welcome-mail": load() must resolve to a module whose default export is the handler.'
      )
    })
  })
})
