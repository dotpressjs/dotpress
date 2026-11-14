import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  createEventBus,
  createWorker,
  defineListener,
  EventEmitError,
  startWorker,
  type ListenerHandler,
} from '../src/index.js'
import {
  createServiceBusHandler,
  createServiceBusSource,
  createServiceBusTransport,
} from '../src/transports/azure-service-bus.js'
import { createLogger, envelopeOf, userCreated } from './support.js'

const listenerOf = (
  name: string,
  handle: ListenerHandler<{ userId: string }>
) => defineListener(userCreated, { name, handle })

afterEach(() => {
  vi.doUnmock('@azure/service-bus')
  vi.resetModules()
})

interface SentMessage {
  body: unknown
  messageId?: string
  [key: string]: unknown
}

/** A Service Bus client recording its calls; batches hold `maxSize` bytes. */
const fakeClient = ({ maxSize = 262_144 } = {}) => {
  const batches: SentMessage[][] = []
  const sendMessages = vi.fn(
    async (sent: { messages: SentMessage[] } | SentMessage) => {
      if (Array.isArray(sent.messages)) {
        batches.push(sent.messages as SentMessage[])
        return
      }
      // A message sent alone: the SDK checks the size of the queue.
      if (JSON.stringify(sent).length > maxSize) {
        throw new Error('MessageSizeExceeded')
      }
      batches.push([sent as SentMessage])
    }
  )
  const sender = {
    createMessageBatch: vi.fn(async (options?: { maxSizeInBytes: number }) => {
      const messages: SentMessage[] = []
      const limit = options?.maxSizeInBytes ?? maxSize
      let size = 0
      return {
        messages,
        maxSizeInBytes: limit,
        get count() {
          return messages.length
        },
        tryAddMessage: (message: SentMessage) => {
          const length = JSON.stringify(message).length
          if (size + length > limit) return false
          size += length
          messages.push(message)
          return true
        },
      }
    }),
    sendMessages,
    close: vi.fn(async () => {}),
  }
  type Handlers = {
    processMessage: (message: object) => Promise<void>
    processError: (args: { error: Error; errorSource: string }) => Promise<void>
  }
  const subscription = { close: vi.fn(async () => {}) }
  const receiver = {
    handlers: undefined as Handlers | undefined,
    subscribe: vi.fn<(handlers: Handlers, options: object) => object>(
      (handlers) => {
        receiver.handlers = handlers
        return subscription
      }
    ),
    completeMessage: vi.fn<(message: object) => Promise<void>>(async () => {}),
    abandonMessage: vi.fn<(message: object) => Promise<void>>(async () => {}),
    deadLetterMessage: vi.fn<
      (message: object, options: object) => Promise<void>
    >(async () => {}),
    close: vi.fn(async () => {}),
  }
  const client = {
    createSender: vi.fn<(queue: string) => typeof sender>(() => sender),
    createReceiver: vi.fn<(queue: string, options: object) => typeof receiver>(
      () => receiver
    ),
    close: vi.fn(async () => {}),
  }
  return { client, sender, receiver, subscription, batches, sendMessages }
}

describe('Service Bus transport', () => {
  it('sends a message per listener, with its id and properties', async () => {
    const { client, batches } = fakeClient()
    const events = createEventBus({
      transport: createServiceBusTransport({
        client: client as never,
        queue: 'events',
      }),
      listeners: [listenerOf('a', () => {}), listenerOf('b', () => {})],
    })
    const { messages } = await events.emit(userCreated, {
      userId: '42',
    })
    expect(client.createSender).toHaveBeenCalledExactlyOnceWith('events')
    expect(batches).toEqual([
      ['a', 'b'].map((listener, index) => ({
        body: expect.objectContaining({ id: messages[index]?.id, listener }),
        contentType: 'application/json',
        messageId: messages[index]?.id,
        subject: 'user.created',
        applicationProperties: { event: 'user.created', listener },
      })),
    ])
    await events.emit(userCreated, { userId: '43' })
    expect(client.createSender).toHaveBeenCalledOnce()
  })

  it('schedules delayed messages', async () => {
    const { client, batches } = fakeClient()
    const transport = createServiceBusTransport({
      client: client as never,
      queue: 'events',
    })
    expect(transport.kind).toBe('azure-service-bus')
    const before = Date.now()
    await transport.send([envelopeOf()], { delay: 90 })
    const scheduled = batches[0]?.[0]?.scheduledEnqueueTimeUtc as Date
    expect(scheduled).toBeInstanceOf(Date)
    expect(scheduled.getTime()).toBeGreaterThanOrEqual(before + 90_000)
    expect(scheduled.getTime()).toBeLessThanOrEqual(Date.now() + 90_000)
    await transport.send([envelopeOf()], { delay: 0 })
    expect(batches[1]?.[0]).not.toHaveProperty('scheduledEnqueueTimeUtc')
  })

  it('fills batches up to their size, and rejects messages too large', async () => {
    const { client, batches } = fakeClient({ maxSize: 2000 })
    const transport = createServiceBusTransport({
      client: client as never,
      queue: 'events',
    })
    const sized = (id: string, size: number) =>
      envelopeOf({ id, payload: { userId: 'x'.repeat(size) } })
    const error = await transport
      .send(
        [
          sized('a', 300),
          sized('b', 300),
          sized('huge', 3000),
          sized('c', 300),
        ],
        { delay: undefined }
      )
      .catch((caught: unknown) => caught)
    expect(
      batches.map((batch) => batch.map(({ messageId }) => messageId))
    ).toEqual([['a', 'b'], ['c']])
    expect(error).toMatchObject({
      name: 'PartialSendError',
      failed: [
        {
          id: 'huge',
          error: new RangeError(
            'Service Bus accepts messages of at most 2000 bytes on this queue (256 KB in the Standard tier).'
          ),
        },
      ],
    })
  })

  it('rejects a first message too large without sending an empty batch', async () => {
    const { client, sendMessages } = fakeClient({ maxSize: 1000 })
    const transport = createServiceBusTransport({
      client: client as never,
      queue: 'events',
    })
    await expect(
      transport.send(
        [
          envelopeOf({
            id: 'huge',
            payload: { userId: 'x'.repeat(2000) },
          }),
        ],
        { delay: undefined }
      )
    ).rejects.toMatchObject({ failed: [{ id: 'huge' }] })
    expect(sendMessages).not.toHaveBeenCalled()
  })

  it('keeps batches under 1 MB, and sends larger messages alone (Premium)', async () => {
    const { client, sender, batches } = fakeClient({ maxSize: 4_000_000 })
    const transport = createServiceBusTransport({
      client: client as never,
      queue: 'events',
    })
    const sized = (id: string, size: number) =>
      envelopeOf({ id, payload: { userId: 'x'.repeat(size) } })
    const error = await transport
      .send(
        [
          sized('a', 600_000),
          sized('large', 2_000_000),
          sized('b', 600_000),
          sized('too-large', 4_000_000),
        ],
        { delay: undefined }
      )
      .catch((caught: unknown) => caught)
    expect(sender.createMessageBatch.mock.calls.slice(0, 2)).toEqual([
      [],
      [{ maxSizeInBytes: 1_048_576 }],
    ])
    expect(
      batches.map((batch) => batch.map(({ messageId }) => messageId))
    ).toEqual([['a'], ['large'], ['b']])
    expect(error).toMatchObject({
      failed: [{ id: 'too-large', error: new Error('MessageSizeExceeded') }],
    })
  })

  it('reports a failed message sent alone', async () => {
    const { client, sendMessages } = fakeClient({ maxSize: 4_000_000 })
    sendMessages.mockRejectedValueOnce(new Error('MessageSizeExceeded'))
    const transport = createServiceBusTransport({
      client: client as never,
      queue: 'events',
    })
    await expect(
      transport.send(
        [
          envelopeOf({
            id: 'large',
            payload: { userId: 'x'.repeat(2_000_000) },
          }),
        ],
        { delay: undefined }
      )
    ).rejects.toMatchObject({
      failed: [{ id: 'large', error: new Error('MessageSizeExceeded') }],
    })
  })

  it('reports the messages of a failed batch, and keeps the others', async () => {
    const { client, batches, sendMessages } = fakeClient({ maxSize: 2000 })
    sendMessages.mockRejectedValueOnce(new Error('ServiceBusy'))
    const transport = createServiceBusTransport({
      client: client as never,
      queue: 'events',
    })
    const sized = (id: string) =>
      envelopeOf({ id, payload: { userId: 'x'.repeat(400) } })
    const error = await transport
      .send([sized('a'), sized('b'), sized('c')], { delay: undefined })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      failed: [
        { id: 'a', error: new Error('ServiceBusy') },
        { id: 'b', error: new Error('ServiceBusy') },
      ],
    })
    expect(batches).toEqual([[expect.objectContaining({ messageId: 'c' })]])

    sendMessages.mockImplementationOnce(async () => {})
    sendMessages.mockRejectedValueOnce(new Error('ServerBusy'))
    const second = await transport
      .send([sized('d'), sized('e'), sized('f')], { delay: undefined })
      .catch((caught: unknown) => caught)
    expect(second).toMatchObject({
      failed: [{ id: 'f', error: new Error('ServerBusy') }],
    })
  })

  it('creates the sender again after a failure', async () => {
    const { client } = fakeClient()
    client.createSender.mockImplementationOnce(() => {
      throw new Error('unauthorized')
    })
    const events = createEventBus({
      transport: createServiceBusTransport({
        client: client as never,
        queue: 'events',
      }),
      listeners: [listenerOf('a', () => {})],
    })
    const error = await events
      .emit(userCreated, { userId: '42' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EventEmitError)
    await events.emit(userCreated, { userId: '42' })
    expect(client.createSender).toHaveBeenCalledTimes(2)
  })

  it('closes the sender, but not a client it did not create', async () => {
    const { client, sender } = fakeClient()
    const transport = createServiceBusTransport({
      client: client as never,
      queue: 'events',
    })
    await transport.close()
    expect(sender.close).not.toHaveBeenCalled()
    await transport.send([envelopeOf()], { delay: undefined })
    await transport.close()
    expect(sender.close).toHaveBeenCalledOnce()
    expect(client.close).not.toHaveBeenCalled()
  })

  it('creates its own client from the connection string, and closes it', async () => {
    const { client, sender } = fakeClient()
    const ServiceBusClient = vi.fn(function (this: object) {
      Object.assign(this, client)
    })
    vi.doMock('@azure/service-bus', () => ({ ServiceBusClient }))
    const { createServiceBusTransport: create } =
      await import('../src/transports/azure-service-bus.js')
    const transport = create({
      connectionString: 'Endpoint=sb://x/',
      queue: 'events',
    })
    await transport.close()
    expect(ServiceBusClient).not.toHaveBeenCalled()
    await transport.send([envelopeOf()], { delay: undefined })
    await transport.send([envelopeOf()], { delay: undefined })
    expect(ServiceBusClient).toHaveBeenCalledExactlyOnceWith('Endpoint=sb://x/')
    await transport.close()
    expect(sender.close).toHaveBeenCalledOnce()
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('asks for @azure/service-bus when it is missing, and tries again', async () => {
    let installed = false
    const { client } = fakeClient()
    vi.doMock('@azure/service-bus', () => {
      if (!installed) throw new Error('Cannot find package')
      return {
        ServiceBusClient: function (this: object) {
          Object.assign(this, client)
        },
      }
    })
    const { createServiceBusTransport: create } =
      await import('../src/transports/azure-service-bus.js')
    const transport = create({
      connectionString: 'Endpoint=sb://x/',
      queue: 'events',
    })
    const error = await transport
      .send([envelopeOf()], { delay: undefined })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      message: 'Install @azure/service-bus to use Azure Service Bus.',
      cause: expect.any(Error),
    })
    await transport.close()
    installed = true
    vi.resetModules()
    await transport.send([envelopeOf()], { delay: undefined })
    expect(client.createSender).toHaveBeenCalledOnce()
  })

  it('checks its options', () => {
    const label = 'createServiceBusTransport()'
    const { client } = fakeClient()
    const create = (options: object) => () =>
      createServiceBusTransport(options as never)
    expect(create(null as never)).toThrow(
      `${label}: expected an object of options.`
    )
    expect(create([] as never)).toThrow(
      `${label}: expected an object of options.`
    )
    expect(create({ client, queue: 'events', topic: 't' })).toThrow(
      `${label}: unknown option "topic".`
    )
    expect(create({ queue: 'events' })).toThrow(
      `${label}: set client or connectionString.`
    )
    expect(create({ client, connectionString: 'x', queue: 'events' })).toThrow(
      `${label}: set client or connectionString.`
    )
    for (const invalid of [null, {}, 'client']) {
      expect(create({ client: invalid, queue: 'events' })).toThrow(
        `${label}: client must be a ServiceBusClient.`
      )
    }
    for (const connectionString of ['', 42]) {
      expect(create({ connectionString, queue: 'events' })).toThrow(
        `${label}: connectionString must be a non-empty string.`
      )
    }
    for (const queue of [undefined, '', 42]) {
      expect(create({ client, queue })).toThrow(
        `${label}: queue must be a non-empty string.`
      )
    }
  })
})

/** A received message. */
const received = (body: unknown, deliveryCount?: number) => ({
  body,
  ...(deliveryCount === undefined ? {} : { deliveryCount }),
})

describe('Service Bus source', () => {
  it('completes handled messages, abandons failed ones, dead-letters the others', async () => {
    const { client, receiver, subscription } = fakeClient()
    const onFailure = vi.fn()
    const worker = createWorker({
      listeners: [
        listenerOf('send-welcome-mail', ({ payload }) => {
          if (payload.userId === 'fail') throw new Error('down')
        }),
      ],
      onFailure,
      maxAttempts: 10,
    })
    const running = startWorker(
      worker,
      createServiceBusSource({ client: client as never, queue: 'events' })
    )
    await vi.waitFor(() => expect(receiver.subscribe).toHaveBeenCalled())
    expect(client.createReceiver).toHaveBeenCalledExactlyOnceWith('events', {
      receiveMode: 'peekLock',
    })
    expect(receiver.subscribe.mock.calls[0]?.[1]).toEqual({
      autoCompleteMessages: false,
      maxConcurrentCalls: 1,
    })
    const handlers = receiver.handlers!

    const ok = received(envelopeOf(), 0)
    await handlers.processMessage(ok)
    expect(receiver.completeMessage).toHaveBeenCalledExactlyOnceWith(ok)
    expect(onFailure).not.toHaveBeenCalled()

    const failed = received(envelopeOf({ payload: { userId: 'fail' } }), 9)
    await handlers.processMessage(failed)
    expect(receiver.abandonMessage).toHaveBeenCalledExactlyOnceWith(failed)
    expect(onFailure).toHaveBeenLastCalledWith(
      new Error('down'),
      expect.objectContaining({ attempt: 10, final: true })
    )

    const dead = received(envelopeOf({ listener: 'removed' }))
    await handlers.processMessage(dead)
    expect(receiver.deadLetterMessage).toHaveBeenCalledExactlyOnceWith(dead, {
      deadLetterReason: 'unknown-listener',
      deadLetterErrorDescription:
        'Unknown listener "removed": this worker runs send-welcome-mail.',
    })
    expect(onFailure).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ attempt: 1 })
    )
    expect(receiver.completeMessage).toHaveBeenCalledOnce()

    await running.stop()
    expect(subscription.close).toHaveBeenCalledOnce()
    expect(receiver.close).toHaveBeenCalledOnce()
    expect(client.close).not.toHaveBeenCalled()
  })

  it('truncates the dead-letter description to 1,024 characters', async () => {
    const { client, receiver } = fakeClient()
    const worker = {
      listeners: [],
      handle: async () => ({
        status: 'dead' as const,
        reason: 'invalid-payload' as const,
        error: 'e'.repeat(2000),
      }),
    }
    const running = startWorker(
      worker,
      createServiceBusSource({ client: client as never, queue: 'events' })
    )
    await vi.waitFor(() => expect(receiver.subscribe).toHaveBeenCalled())
    await receiver.handlers!.processMessage(received(envelopeOf()))
    expect(receiver.deadLetterMessage.mock.calls[0]?.[1]).toEqual({
      deadLetterReason: 'invalid-payload',
      deadLetterErrorDescription: 'e'.repeat(1024),
    })
    await running.stop()
  })

  it('passes its options to the receiver', async () => {
    const { client, receiver } = fakeClient()
    const running = startWorker(
      createWorker({ listeners: [] }),
      createServiceBusSource({
        client: client as never,
        queue: 'events',
        concurrency: 8,
        maxLockRenewal: '10m',
      })
    )
    await vi.waitFor(() => expect(receiver.subscribe).toHaveBeenCalled())
    expect(client.createReceiver.mock.calls[0]?.[1]).toEqual({
      receiveMode: 'peekLock',
      maxAutoLockRenewalDurationInMs: 600_000,
    })
    expect(receiver.subscribe.mock.calls[0]?.[1]).toEqual({
      autoCompleteMessages: false,
      maxConcurrentCalls: 8,
    })
    await running.stop()
  })

  it('logs receiver errors', async () => {
    const { client, receiver } = fakeClient()
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners: [] }),
      createServiceBusSource({ client: client as never, queue: 'events' }),
      { logger }
    )
    await vi.waitFor(() => expect(receiver.subscribe).toHaveBeenCalled())
    await receiver.handlers!.processError({
      error: new Error('Unauthorized'),
      errorSource: 'receive',
    })
    await running.stop()
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Service Bus receiver error',
      data: { queue: 'events', source: 'receive', error: 'Unauthorized' },
    })
  })

  it('waits for the messages in progress before closing the receiver', async () => {
    const { client, receiver } = fakeClient()
    let finish: () => void = () => {}
    const worker = createWorker({
      listeners: [
        listenerOf(
          'send-welcome-mail',
          () => new Promise<void>((resolve) => (finish = resolve))
        ),
      ],
    })
    const logger = createLogger()
    const running = startWorker(
      worker,
      createServiceBusSource({ client: client as never, queue: 'events' }),
      { logger }
    )
    await vi.waitFor(() => expect(receiver.subscribe).toHaveBeenCalled())
    const message = received(envelopeOf())
    const processing = receiver.handlers!.processMessage(message)
    const stopping = running.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(receiver.close).not.toHaveBeenCalled()
    finish()
    await processing
    await stopping
    expect(receiver.completeMessage).toHaveBeenCalledExactlyOnceWith(message)
    expect(receiver.completeMessage.mock.invocationCallOrder[0]).toBeLessThan(
      receiver.close.mock.invocationCallOrder[0] as number
    )
    expect(logger.entries.filter(({ level }) => level === 'warn')).toEqual([])
  })

  it('stops without waiting after closeTimeout', async () => {
    const { client, receiver } = fakeClient()
    const worker = createWorker({
      listeners: [listenerOf('send-welcome-mail', () => new Promise(() => {}))],
    })
    const logger = createLogger()
    const running = startWorker(
      worker,
      createServiceBusSource({
        client: client as never,
        queue: 'events',
        closeTimeout: '50ms',
      }),
      { logger }
    )
    await vi.waitFor(() => expect(receiver.subscribe).toHaveBeenCalled())
    void receiver.handlers!.processMessage(received(envelopeOf()))
    await running.stop()
    expect(receiver.close).toHaveBeenCalledOnce()
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message:
        'Service Bus receiver not closed in time: stopped without waiting',
      data: { queue: 'events', closeTimeout: 50 },
    })
  })

  it('stops at once when already aborted', async () => {
    const { client, subscription, receiver } = fakeClient()
    await createServiceBusSource({
      client: client as never,
      queue: 'events',
    }).consume(createWorker({ listeners: [] }), {
      signal: AbortSignal.abort(),
      logger: createLogger(),
    })
    expect(subscription.close).toHaveBeenCalledOnce()
    expect(receiver.close).toHaveBeenCalledOnce()
  })

  it('creates its own client from the connection string, and closes it', async () => {
    const { client, receiver } = fakeClient()
    receiver.close.mockRejectedValueOnce(new Error('already closed'))
    const ServiceBusClient = vi.fn(function (this: object) {
      Object.assign(this, client)
    })
    vi.doMock('@azure/service-bus', () => ({ ServiceBusClient }))
    const { createServiceBusSource: create } =
      await import('../src/transports/azure-service-bus.js')
    const running = startWorker(
      createWorker({ listeners: [] }),
      create({ connectionString: 'Endpoint=sb://x/', queue: 'events' })
    )
    await vi.waitFor(() => expect(receiver.subscribe).toHaveBeenCalled())
    await running.stop()
    expect(ServiceBusClient).toHaveBeenCalledExactlyOnceWith('Endpoint=sb://x/')
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('checks its options', () => {
    const label = 'createServiceBusSource()'
    const { client } = fakeClient()
    const create = (options: object) => () =>
      createServiceBusSource({
        client: client as never,
        queue: 'events',
        ...options,
      })
    expect(create({ topic: 't' })).toThrow(`${label}: unknown option "topic".`)
    expect(create({ client: undefined })).toThrow(
      `${label}: set client or connectionString.`
    )
    for (const concurrency of [0, 1.5, '2']) {
      expect(create({ concurrency })).toThrow(
        `${label}: concurrency must be a positive integer.`
      )
    }
    for (const maxLockRenewal of [-1, '1000', '1 m']) {
      expect(create({ maxLockRenewal })).toThrow(
        `${label}: maxLockRenewal must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.`
      )
    }
    for (const closeTimeout of [-1, '1000']) {
      expect(create({ closeTimeout })).toThrow(
        `${label}: closeTimeout must be a number of seconds, or a duration like '500ms', '30s', '10m', '1h' or '7d'.`
      )
    }
    expect(
      create({ concurrency: 1, maxLockRenewal: 0, closeTimeout: '500ms' })
    ).not.toThrow()
  })
})

describe('Service Bus Azure Functions handler', () => {
  const workerOf = (handle: ListenerHandler<{ userId: string }>) =>
    createWorker({
      listeners: [listenerOf('send-welcome-mail', handle)],
      maxAttempts: 10,
    })

  it('runs the listener of the message', async () => {
    const handle = vi.fn()
    const handler = createServiceBusHandler(workerOf(handle))
    await handler(envelopeOf(), { triggerMetadata: { deliveryCount: 3 } })
    await handler(JSON.stringify(envelopeOf()))
    expect(
      handle.mock.calls.map(([context]) => [context.payload, context.attempt])
    ).toEqual([
      [{ userId: '42' }, 3],
      [{ userId: '42' }, 1],
    ])
  })

  it('throws to have failed messages delivered again', async () => {
    const handler = createServiceBusHandler(
      workerOf(() => {
        throw new Error('down')
      })
    )
    await expect(
      handler(envelopeOf(), { triggerMetadata: {} })
    ).rejects.toThrow(new Error('down'))
    const failing = createServiceBusHandler(
      workerOf(() => {
        throw 'not an error'
      })
    )
    await expect(failing(envelopeOf())).rejects.toThrow(
      new Error('not an error')
    )
    await expect(
      handler(envelopeOf({ listener: 'removed' }), {
        triggerMetadata: { deliveryCount: '2' },
      })
    ).rejects.toThrow(
      'Unknown listener "removed": this worker runs send-welcome-mail.'
    )
    const onFailure = vi.fn()
    await createServiceBusHandler(createWorker({ listeners: [], onFailure }))(
      envelopeOf(),
      { triggerMetadata: { deliveryCount: '2' } }
    ).catch(() => {})
    expect(onFailure.mock.calls[0]?.[1]).toMatchObject({ attempt: 1 })
  })

  it('refuses batches', async () => {
    const handler = createServiceBusHandler(workerOf(() => {}))
    await expect(handler([envelopeOf()])).rejects.toThrow(
      new TypeError(
        'createServiceBusHandler(): expected one message per invocation (cardinality "one").'
      )
    )
  })

  it('sends dead messages to the dead-letter queue', async () => {
    const logger = createLogger()
    const { client, batches, sendMessages } = fakeClient()
    const handler = createServiceBusHandler(
      workerOf(() => {}),
      {
        deadLetter: { client: client as never, queue: 'events-dlq' },
        logger,
      }
    )
    const body = envelopeOf({ listener: 'removed' })
    await handler(body)
    expect(client.createSender).toHaveBeenCalledExactlyOnceWith('events-dlq')
    expect(batches).toEqual([
      [
        {
          body,
          contentType: 'application/json',
          applicationProperties: {
            reason: 'unknown-listener',
            error:
              'Unknown listener "removed": this worker runs send-welcome-mail.',
          },
        },
      ],
    ])

    sendMessages.mockRejectedValueOnce(new Error('QuotaExceeded'))
    const error = await handler(body).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      message: 'Cannot send the message to the dead-letter queue.',
      cause: new Error('QuotaExceeded'),
    })
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Cannot send the message to the dead-letter queue',
      data: { error: 'QuotaExceeded' },
    })
  })

  it('does not send retried messages to the dead-letter queue', async () => {
    const { client, sendMessages } = fakeClient()
    const handler = createServiceBusHandler(
      workerOf(() => {
        throw new Error('down')
      }),
      { deadLetter: { client: client as never, queue: 'events-dlq' } }
    )
    await expect(handler(envelopeOf())).rejects.toThrow('down')
    expect(sendMessages).not.toHaveBeenCalled()
  })

  it('checks its options', () => {
    const label = 'createServiceBusHandler()'
    const worker = workerOf(() => {})
    const { client } = fakeClient()
    expect(() => createServiceBusHandler({} as never)).toThrow(
      `${label}: expected a worker created by createWorker().`
    )
    expect(() => createServiceBusHandler(null as never)).toThrow(
      'expected a worker'
    )
    expect(() =>
      createServiceBusHandler(worker, { retryDelay: 1 } as never)
    ).toThrow(`${label}: unknown option "retryDelay".`)
    expect(() =>
      createServiceBusHandler(worker, { deadLetter: 'dlq' as never })
    ).toThrow(`${label}: deadLetter: expected an object of options.`)
    expect(() =>
      createServiceBusHandler(worker, {
        deadLetter: {
          client: client as never,
          queue: 'dlq',
          delay: 1,
        } as never,
      })
    ).toThrow(`${label}: deadLetter: unknown option "delay".`)
    expect(() =>
      createServiceBusHandler(worker, {
        deadLetter: { queue: 'dlq' } as never,
      })
    ).toThrow(`${label}: deadLetter: set client or connectionString.`)
  })
})

// Against the Service Bus emulator, with the queues of
// test/fixtures/azure-service-bus-emulator.json.
const connectionString = process.env.SERVICE_BUS_CONNECTION

describe.skipIf(!connectionString)('Service Bus (emulator)', () => {
  let client: import('@azure/service-bus').ServiceBusClient

  /** Removes the messages left in a queue (and its dead-letter queue). */
  const drain = async (queue: string, subQueueType?: 'deadLetter') => {
    const receiver = client.createReceiver(queue, {
      receiveMode: 'receiveAndDelete',
      ...(subQueueType ? { subQueueType } : {}),
    })
    while (
      (await receiver.receiveMessages(50, { maxWaitTimeInMs: 300 })).length > 0
    ) {
      // Keep receiving.
    }
    await receiver.close()
  }

  /** Receives the messages of the dead-letter queue. */
  const deadLetters = async (queue: string, count: number) => {
    const receiver = client.createReceiver(queue, {
      receiveMode: 'receiveAndDelete',
      subQueueType: 'deadLetter',
    })
    const messages = await receiver.receiveMessages(count, {
      maxWaitTimeInMs: 5000,
    })
    await receiver.close()
    return messages
  }

  beforeAll(async () => {
    const { ServiceBusClient } = await import('@azure/service-bus')
    client = new ServiceBusClient(connectionString as string)
    for (const queue of ['events', 'events-dedup', 'events-functions-dlq']) {
      await drain(queue)
      await drain(queue, 'deadLetter')
    }
  })
  afterAll(() => client.close())

  const transportOf = (queue = 'events') =>
    createServiceBusTransport({ client, queue })

  it('sends with the transport, and receives with the source', async () => {
    const attempts: number[] = []
    const listeners = [
      listenerOf('flaky', ({ attempt }) => {
        attempts.push(attempt)
        if (attempt < 2) throw new Error('down')
      }),
      listenerOf('steady', ({ attempt }) => void attempts.push(attempt * 10)),
    ]
    const events = createEventBus({ transport: transportOf(), listeners })
    await events.emit(userCreated, { userId: '42' })
    const running = startWorker(
      createWorker({ listeners, maxAttempts: 3 }),
      createServiceBusSource({ client, queue: 'events', concurrency: 2 })
    )
    await vi.waitFor(() => expect(attempts.sort()).toEqual([1, 10, 2]), {
      timeout: 15_000,
    })
    await running.stop()
  })

  it('moves dead messages and exhausted ones to the dead-letter queue', async () => {
    const onFailure = vi.fn()
    const listener = listenerOf('broken', () => {
      throw new Error('always down')
    })
    const transport = transportOf()
    await createEventBus({ transport, listeners: [listener] }).emit(
      userCreated,
      { userId: '42' }
    )
    await transport.send([envelopeOf({ id: 'dead-1', listener: 'removed' })], {
      delay: undefined,
    })
    const running = startWorker(
      createWorker({ listeners: [listener], maxAttempts: 3, onFailure }),
      createServiceBusSource({ client, queue: 'events' })
    )
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(4), {
      timeout: 20_000,
    })
    await running.stop()
    expect(
      onFailure.mock.calls
        .map(([, { reason, attempt, final }]) => [reason, attempt, final])
        .sort()
    ).toEqual([
      ['listener-error', 1, false],
      ['listener-error', 2, false],
      ['listener-error', 3, true],
      ['unknown-listener', 1, true],
    ])
    const dead = await deadLetters('events', 2)
    expect(
      dead
        .map(({ deadLetterReason, deadLetterErrorDescription, body }) => ({
          deadLetterReason,
          deadLetterErrorDescription,
          listener: (body as { listener: string }).listener,
        }))
        .sort((a, b) => a.listener.localeCompare(b.listener))
    ).toEqual([
      {
        deadLetterReason: 'MaxDeliveryCountExceeded',
        deadLetterErrorDescription: expect.any(String),
        listener: 'broken',
      },
      {
        deadLetterReason: 'unknown-listener',
        deadLetterErrorDescription:
          'Unknown listener "removed": this worker runs broken.',
        listener: 'removed',
      },
    ])
  })

  it('delays messages', async () => {
    const received: number[] = []
    const listener = listenerOf('later', () => void received.push(Date.now()))
    const sent = Date.now()
    await createEventBus({
      transport: transportOf(),
      listeners: [listener],
    }).emit(userCreated, { userId: '42' }, { delay: 3 })
    const running = startWorker(
      createWorker({ listeners: [listener] }),
      createServiceBusSource({ client, queue: 'events' })
    )
    await vi.waitFor(() => expect(received).toHaveLength(1), {
      timeout: 15_000,
    })
    await running.stop()
    expect(received[0]).toBeGreaterThanOrEqual(sent + 2500)
  })

  it('ignores a message emitted twice with duplicate detection', async () => {
    const transport = transportOf('events-dedup')
    // Unique per run: the detection window outlives the test.
    const id = `same-${Date.now()}`
    await transport.send([envelopeOf({ id })], { delay: undefined })
    await transport.send([envelopeOf({ id })], { delay: undefined })
    const receiver = client.createReceiver('events-dedup', {
      receiveMode: 'receiveAndDelete',
    })
    const messages = await receiver.receiveMessages(10, {
      maxWaitTimeInMs: 3000,
    })
    await receiver.close()
    expect(messages.map(({ messageId }) => messageId)).toEqual([id])
    expect(messages[0]?.body).toEqual(envelopeOf({ id }))
    expect(messages[0]?.applicationProperties).toEqual({
      event: 'user.created',
      listener: 'send-welcome-mail',
    })
  })

  it('sends dead messages of Azure Functions to a queue', async () => {
    const handler = createServiceBusHandler(createWorker({ listeners: [] }), {
      deadLetter: { client, queue: 'events-functions-dlq' },
    })
    await handler(envelopeOf({ listener: 'removed' }), {
      triggerMetadata: { deliveryCount: 1 },
    })
    const receiver = client.createReceiver('events-functions-dlq', {
      receiveMode: 'receiveAndDelete',
    })
    const [message] = await receiver.receiveMessages(1, {
      maxWaitTimeInMs: 3000,
    })
    await receiver.close()
    expect(message?.body).toEqual(envelopeOf({ listener: 'removed' }))
    expect(message?.applicationProperties).toEqual({
      reason: 'unknown-listener',
      error: 'Unknown listener "removed": this worker runs no listener.',
    })
  })
})
