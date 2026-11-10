import { SQSClient } from '@aws-sdk/client-sqs'
import {
  afterAll,
  beforeAll,
  beforeEach,
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
  type Envelope,
  type ListenerHandler,
} from '../src/index.js'
import {
  createSqsHandler,
  createSqsSource,
  createSqsTransport,
  queueUrlOf,
  type SqsRecord,
} from '../src/transports/aws-sqs.js'
import { createLogger, envelopeOf, practitionerCreated } from './support.js'
import { startSqsServer } from './aws-sqs-server.js'

let server: Awaited<ReturnType<typeof startSqsServer>>
let client: SQSClient

beforeAll(async () => {
  server = await startSqsServer()
  client = new SQSClient({
    endpoint: server.url,
    region: 'eu-west-3',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })
})

afterAll(async () => {
  client.destroy()
  await server.close()
})

beforeEach(() => {
  server.calls.length = 0
})

let queueCount = 0
/** A fresh queue. */
const newQueue = (suffix = '') => {
  queueCount += 1
  const name = `events-${queueCount}${suffix}`
  return { url: server.queueUrl(name), queue: () => server.queue(name) }
}

const listenerOf = (
  name: string,
  handle: ListenerHandler<{ practitionerId: string }>
) => defineListener(practitionerCreated, { name, handle })

/** Calls of an action on a queue (earlier tests may still have requests in flight). */
const callsOf = (queueUrl: string, action: string) =>
  server.calls.filter(
    (call) => call.action === action && call.input.QueueUrl === queueUrl
  )

const bodies = (queue: ReturnType<typeof newQueue>) =>
  queue.queue().messages.map(({ body }) => JSON.parse(body) as Envelope)

describe('SQS transport', () => {
  it('sends one message per listener, with attributes', async () => {
    const queue = newQueue()
    const events = createEventBus({
      transport: createSqsTransport({ queueUrl: queue.url, client }),
      listeners: [listenerOf('a', () => {}), listenerOf('b', () => {})],
    })
    const { messages } = await events.emit(
      practitionerCreated,
      { practitionerId: '42' },
      { delay: 30 }
    )

    expect(bodies(queue)).toEqual([
      expect.objectContaining({ id: messages[0]?.id, listener: 'a' }),
      expect.objectContaining({ id: messages[1]?.id, listener: 'b' }),
    ])
    expect(queue.queue().messages[0]?.attributes).toEqual({
      event: { DataType: 'String', StringValue: 'practitioner.created' },
      listener: { DataType: 'String', StringValue: 'a' },
    })
    expect(server.calls).toEqual([
      {
        action: 'SendMessageBatch',
        input: {
          QueueUrl: queue.url,
          Entries: [
            expect.objectContaining({ Id: messages[0]?.id, DelaySeconds: 30 }),
            expect.objectContaining({ Id: messages[1]?.id, DelaySeconds: 30 }),
          ],
        },
      },
    ])
  })

  it('sends batches of 10 messages', async () => {
    const queue = newQueue()
    const listeners = Array.from({ length: 23 }, (_, index) =>
      listenerOf(`l${index}`, () => {})
    )
    const events = createEventBus({
      transport: createSqsTransport({ queueUrl: queue.url, client }),
      listeners,
    })
    await events.emit(practitionerCreated, { practitionerId: '1' })
    expect(
      server.calls.map(({ input }) => (input.Entries as unknown[]).length)
    ).toEqual([10, 10, 3])
    // No delay: the default of the queue.
    expect(
      (server.calls[0]?.input.Entries as Record<string, unknown>[])[0]
    ).not.toHaveProperty('DelaySeconds')
    expect(queue.queue().messages).toHaveLength(23)
  })

  it('splits batches at 1 MiB, and rejects larger messages', async () => {
    const send = vi.fn(async () => ({ Failed: [] }))
    const transport = createSqsTransport({
      queueUrl: 'https://sqs.eu-west-3.amazonaws.com/1/q',
      client: { send },
    })
    const big = (listener: string, size: number) => ({
      ...envelopeOf({ id: `id-${listener}`, listener }),
      payload: 'x'.repeat(size),
    })
    const error = await transport
      .send([big('a', 600_000), big('b', 600_000), big('c', 1_048_576)], {
        delay: undefined,
      })
      .catch((e: unknown) => e)
    expect(send).toHaveBeenCalledTimes(2)
    expect(error).toMatchObject({
      name: 'PartialSendError',
      failed: [
        {
          id: 'id-c',
          error: expect.objectContaining({
            name: 'RangeError',
            message: expect.stringMatching(
              /^SQS accepts messages of at most 1048576 bytes \(attributes included\), got \d+\.$/
            ),
          }),
        },
      ],
    })
  })

  it('adds up the sizes of a batch', async () => {
    const send = vi.fn<(command: object) => Promise<object>>(async () => ({}))
    const transport = createSqsTransport({
      queueUrl: 'https://sqs.eu-west-3.amazonaws.com/1/q',
      client: { send },
    })
    const big = (listener: string) => ({
      ...envelopeOf({ id: `id-${listener}`, listener }),
      payload: 'x'.repeat(400_000),
    })
    await transport.send([big('a'), big('b'), big('c')], { delay: undefined })
    expect(
      send.mock.calls.map(
        ([command]) =>
          (command as unknown as { input: { Entries: unknown[] } }).input
            .Entries.length
      )
    ).toEqual([2, 1])
  })

  it('counts the attributes in the size of a message', async () => {
    const send = vi.fn(async () => ({}))
    const transport = createSqsTransport({
      queueUrl: 'https://sqs.eu-west-3.amazonaws.com/1/q',
      client: { send },
    })
    const sized = (target: number) => {
      const envelope = { ...envelopeOf(), payload: '' }
      const attributes =
        'event'.length +
        'String'.length +
        envelope.event.length +
        'listener'.length +
        'String'.length +
        envelope.listener.length
      const padding = target - attributes - JSON.stringify(envelope).length
      return { ...envelope, payload: 'x'.repeat(padding) }
    }
    // Exactly 1 MiB, attributes included: accepted.
    await transport.send([sized(1_048_576)], { delay: undefined })
    expect(send).toHaveBeenCalledOnce()
    // One byte more: rejected, although the body alone fits.
    await expect(
      transport.send([sized(1_048_577)], { delay: undefined })
    ).rejects.toMatchObject({
      failed: [
        {
          error: expect.objectContaining({
            message:
              'SQS accepts messages of at most 1048576 bytes (attributes included), got 1048577.',
          }),
        },
      ],
    })
    expect(send).toHaveBeenCalledOnce()
  })

  it('uses message groups and deduplication with FIFO queues', async () => {
    const queue = newQueue('.fifo')
    const events = createEventBus({
      transport: createSqsTransport({ queueUrl: queue.url, client }),
      listeners: [listenerOf('a', () => {})],
    })
    const { messages } = await events.emit(practitionerCreated, {
      practitionerId: '42',
    })
    expect((server.calls[0]?.input.Entries as unknown[])[0]).toMatchObject({
      Id: messages[0]?.id,
      MessageGroupId: 'a',
      MessageDeduplicationId: messages[0]?.id,
    })

    const grouped = createEventBus({
      transport: createSqsTransport({
        queueUrl: queue.url,
        client,
        messageGroupId: (envelope) =>
          (envelope.payload as { practitionerId: string }).practitionerId,
      }),
      listeners: [listenerOf('a', () => {})],
    })
    await grouped.emit(
      practitionerCreated,
      { practitionerId: '42' },
      { delay: 0 }
    )
    expect((server.calls[1]?.input.Entries as unknown[])[0]).toMatchObject({
      MessageGroupId: '42',
    })
    expect((server.calls[1]?.input.Entries as unknown[])[0]).not.toHaveProperty(
      'DelaySeconds'
    )
  })

  it.each([
    [
      'https://sqs.eu-west-3.amazonaws.com/1/q',
      901,
      'SQS accepts delays of at most 900 seconds, got 901.',
    ],
    [
      'https://sqs.eu-west-3.amazonaws.com/1/q.fifo',
      1,
      'SQS FIFO queues do not accept per-message delays.',
    ],
  ])(
    'rejects delays that %s does not accept',
    async (queueUrl, delay, message) => {
      const send = vi.fn()
      const events = createEventBus({
        transport: createSqsTransport({ queueUrl, client: { send } }),
        listeners: [listenerOf('a', () => {})],
      })
      const error = await events
        .emit(practitionerCreated, { practitionerId: '1' }, { delay })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(EventEmitError)
      expect((error as Error).cause).toEqual(new RangeError(message))
      expect(send).not.toHaveBeenCalled()
    }
  )

  it('accepts a delay of 900 seconds', async () => {
    const send = vi.fn(async () => ({}))
    await createSqsTransport({
      queueUrl: 'https://sqs.eu-west-3.amazonaws.com/1/q',
      client: { send },
    }).send([envelopeOf()], { delay: 900 })
    expect(send).toHaveBeenCalledOnce()
  })

  it('reports failed entries and failed batches', async () => {
    const queue = newQueue()
    const listeners = Array.from({ length: 12 }, (_, index) =>
      listenerOf(`l${index}`, () => {})
    )
    const failure = new Error('network down')
    let calls = 0
    const send = vi.fn(
      async (command: { input: { Entries: { Id: string }[] } }) => {
        calls += 1
        if (calls === 2) throw failure
        const [first] = command.input.Entries
        return {
          Failed: [
            { Id: first?.Id, Code: 'InternalError', Message: 'try again' },
            { Id: command.input.Entries[1]?.Id, Code: 'Throttled' },
          ],
        }
      }
    )
    const events = createEventBus({
      transport: createSqsTransport({ queueUrl: queue.url, client: { send } }),
      listeners,
    })
    const error = (await events
      .emit(practitionerCreated, { practitionerId: '1' })
      .catch((e: unknown) => e)) as EventEmitError
    expect(error.sent).toHaveLength(8)
    expect(error.failed.map(({ listener }) => listener)).toEqual([
      'l0',
      'l1',
      'l10',
      'l11',
    ])
    expect(
      error.failed.map(({ error: cause }) => (cause as Error).message)
    ).toEqual([
      'InternalError: try again',
      'Throttled',
      'network down',
      'network down',
    ])
  })

  it('reports errors of the API', async () => {
    const queue = newQueue()
    server.failNext(
      'SendMessageBatch',
      'QueueDoesNotExist',
      'The queue does not exist.',
      400,
      queue.url
    )
    const events = createEventBus({
      transport: createSqsTransport({ queueUrl: queue.url, client }),
      listeners: [listenerOf('a', () => {})],
    })
    await expect(
      events.emit(practitionerCreated, { practitionerId: '1' })
    ).rejects.toThrow(
      /not fully emitted: 1 of 1 messages failed \(a\): The queue does not exist\./
    )
  })

  it('creates its client from clientConfig, on first use', async () => {
    const queue = newQueue()
    const transport = createSqsTransport({
      queueUrl: queue.url,
      clientConfig: {
        endpoint: server.url,
        region: 'eu-west-3',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      },
    })
    expect(transport.kind).toBe('aws-sqs')
    await transport.send([envelopeOf()], { delay: undefined })
    expect(queue.queue().messages).toHaveLength(1)
  })

  it.each([
    [
      'not an object',
      'x',
      'createSqsTransport(): expected an object of options.',
    ],
    [
      'an unknown option',
      { queueUrl: 'https://x/1/q', region: 'eu' },
      'createSqsTransport(): unknown option "region".',
    ],
    [
      'no queue URL',
      {},
      'createSqsTransport(): queueUrl must be the URL of an SQS queue.',
    ],
    [
      'a queue name',
      { queueUrl: 'events' },
      'createSqsTransport(): queueUrl must be the URL of an SQS queue.',
    ],
    [
      'client and clientConfig',
      { queueUrl: 'https://x/1/q', client: { send() {} }, clientConfig: {} },
      'createSqsTransport(): set client or clientConfig, not both.',
    ],
    [
      'a client without send()',
      { queueUrl: 'https://x/1/q', client: {} },
      'createSqsTransport(): client must have a send() method.',
    ],
    [
      'a null client',
      { queueUrl: 'https://x/1/q', client: null },
      'createSqsTransport(): client must have a send() method.',
    ],
    [
      'a message group that is not a function',
      { queueUrl: 'https://x/1/q', messageGroupId: 'g' },
      'createSqsTransport(): messageGroupId must be a function.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createSqsTransport(options as never)).toThrow(
      new TypeError(message)
    )
  })
})

describe('queueUrlOf()', () => {
  it.each([
    [
      'arn:aws:sqs:eu-west-3:123456789012:events',
      'https://sqs.eu-west-3.amazonaws.com/123456789012/events',
    ],
    [
      'arn:aws-cn:sqs:cn-north-1:123456789012:events.fifo',
      'https://sqs.cn-north-1.amazonaws.com.cn/123456789012/events.fifo',
    ],
    ['arn:aws:sqs:eu-west-3:123456789012', undefined],
    ['arn:aws:sqs::123456789012:events', undefined],
    ['arn:aws:sqs:eu-west-3::events', undefined],
    ['arn::sqs:eu-west-3:123456789012:events', undefined],
    ['events', undefined],
  ])('gives the URL of %s', (arn, url) => {
    expect(queueUrlOf(arn)).toBe(url)
  })
})

describe('SQS Lambda handler', () => {
  const recordOf = (
    envelope: Envelope,
    overrides: Partial<SqsRecord> = {}
  ): SqsRecord => ({
    messageId: `m-${envelope.listener}`,
    receiptHandle: `r-${envelope.listener}`,
    body: JSON.stringify(envelope),
    attributes: { ApproximateReceiveCount: '1' },
    eventSourceARN: 'arn:aws:sqs:eu-west-3:123456789012:events',
    ...overrides,
  })

  const workerOf = (
    handlers: Record<string, ListenerHandler<{ practitionerId: string }>>
  ) =>
    createWorker({
      listeners: Object.entries(handlers).map(([name, handle]) =>
        listenerOf(name, handle)
      ),
    })

  it('reports the failed messages only', async () => {
    const attempts: number[] = []
    const handler = createSqsHandler(
      workerOf({
        ok: ({ attempt }) => void attempts.push(attempt),
        failing: () => {
          throw new Error('down')
        },
      })
    )
    const response = await handler({
      Records: [
        recordOf(envelopeOf({ listener: 'ok' }), {
          attributes: { ApproximateReceiveCount: '3' },
        }),
        recordOf(envelopeOf({ listener: 'failing' })),
        recordOf(envelopeOf({ listener: 'ok' }), {
          messageId: 'm-ok-2',
          attributes: {},
        }),
        recordOf(envelopeOf({ listener: 'unknown' })),
      ],
    })
    expect(response).toEqual({
      batchItemFailures: [
        { itemIdentifier: 'm-failing' },
        { itemIdentifier: 'm-unknown' },
      ],
    })
    expect(attempts.sort()).toEqual([1, 3])
  })

  it('handles empty events', async () => {
    const handler = createSqsHandler(workerOf({}))
    expect(await handler({ Records: [] })).toEqual({ batchItemFailures: [] })
    expect(await handler(undefined as never)).toEqual({ batchItemFailures: [] })
  })

  it('stops at the first failure of a FIFO queue', async () => {
    const ran: string[] = []
    const handler = createSqsHandler(
      workerOf({
        a: () => void ran.push('a'),
        b: () => {
          throw new Error('down')
        },
        c: () => void ran.push('c'),
      })
    )
    const fifo = { eventSourceARN: 'arn:aws:sqs:eu-west-3:1:events.fifo' }
    const response = await handler({
      Records: ['a', 'b', 'c', 'a'].map((listener, index) =>
        recordOf(envelopeOf({ listener }), { ...fifo, messageId: `m${index}` })
      ),
    })
    expect(ran).toEqual(['a'])
    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: 'm1' },
      { itemIdentifier: 'm2' },
      { itemIdentifier: 'm3' },
    ])
  })

  it('copies dead messages to the dead-letter queue', async () => {
    const dlq = newQueue('-dlq')
    const handler = createSqsHandler(workerOf({ ok: () => {} }), {
      client,
      deadLetterQueueUrl: dlq.url,
    })
    const envelope = envelopeOf({ listener: 'removed-listener' })
    const response = await handler({ Records: [recordOf(envelope)] })
    expect(response.batchItemFailures).toEqual([])
    expect(dlq.queue().messages).toEqual([
      expect.objectContaining({
        body: JSON.stringify(envelope),
        attributes: {
          reason: { DataType: 'String', StringValue: 'unknown-listener' },
          error: {
            DataType: 'String',
            StringValue:
              'Unknown listener "removed-listener": this worker runs ok.',
          },
        },
      }),
    ])
  })

  it('keeps dead messages when the dead-letter queue fails', async () => {
    const dlq = newQueue('-dlq')
    const logger = createLogger()
    server.failNext(
      'SendMessage',
      'AccessDenied',
      'Access denied.',
      403,
      dlq.url
    )
    const handler = createSqsHandler(workerOf({}), {
      client,
      deadLetterQueueUrl: dlq.url,
      logger,
    })
    const response = await handler({ Records: [recordOf(envelopeOf())] })
    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: 'm-send-welcome-mail' },
    ])
    expect(logger.entries).toEqual([
      {
        level: 'error',
        message: 'Cannot copy the message to the dead-letter queue',
        data: { deadLetterQueueUrl: dlq.url, error: 'Access denied.' },
      },
    ])
  })

  it('delays retries', async () => {
    const queue = newQueue()
    const retryDelay = vi.fn((attempt: number) => 2 ** attempt * 10.4)
    const failing = workerOf({
      'send-welcome-mail': () => {
        throw new Error('down')
      },
    })
    const handler = createSqsHandler(failing, {
      client,
      queueUrl: queue.url,
      retryDelay,
    })
    await handler({
      Records: [
        recordOf(envelopeOf(), {
          attributes: { ApproximateReceiveCount: '2' },
        }),
      ],
    })
    expect(retryDelay).toHaveBeenCalledWith(2)
    expect(server.calls).toEqual([
      {
        action: 'ChangeMessageVisibility',
        input: {
          QueueUrl: queue.url,
          ReceiptHandle: 'r-send-welcome-mail',
          VisibilityTimeout: 42,
        },
      },
    ])
  })

  it('caps retry delays, and logs their failures', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValue({})
    const logger = createLogger()
    const handler = createSqsHandler(
      workerOf({
        'send-welcome-mail': () => {
          throw new Error('down')
        },
      }),
      {
        client: { send },
        retryDelay: (attempt) => (attempt === 1 ? -5 : 1e9),
        logger,
      }
    )
    const records = [
      recordOf(envelopeOf()),
      recordOf(envelopeOf(), {
        messageId: 'm2',
        attributes: { ApproximateReceiveCount: '2' },
      }),
    ]
    const response = await handler({ Records: records })
    expect(response.batchItemFailures).toHaveLength(2)
    // Queue URL derived from the ARN.
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      expect.objectContaining({
        QueueUrl: 'https://sqs.eu-west-3.amazonaws.com/123456789012/events',
        VisibilityTimeout: 0,
      }),
      expect.objectContaining({ VisibilityTimeout: 43_200 }),
    ])
    expect(logger.entries).toEqual([
      {
        level: 'warn',
        message: 'Cannot delay the retry of the message',
        data: {
          queueUrl: 'https://sqs.eu-west-3.amazonaws.com/123456789012/events',
          error: 'denied',
        },
      },
    ])
  })

  it('does not delay dead messages', async () => {
    const send = vi.fn()
    const handler = createSqsHandler(workerOf({}), {
      client: { send },
      retryDelay: () => 10,
      queueUrl: 'https://sqs.eu-west-3.amazonaws.com/1/q',
    })
    const response = await handler({ Records: [recordOf(envelopeOf())] })
    expect(response.batchItemFailures).toHaveLength(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('truncates long errors in the dead-letter queue', async () => {
    const send = vi.fn(async () => ({}))
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `listener-${'x'.repeat(80)}-${index}`,
        () => {},
      ])
    )
    const handler = createSqsHandler(workerOf(many), {
      client: { send },
      deadLetterQueueUrl: 'https://sqs.eu-west-3.amazonaws.com/1/dlq',
    })
    await handler({ Records: [recordOf(envelopeOf())] })
    const [command] = send.mock.calls[0] as unknown as [
      { input: { MessageAttributes: { error: { StringValue: string } } } },
    ]
    const error = command.input.MessageAttributes.error.StringValue
    expect(error).toHaveLength(1024)
    expect(error.startsWith('Unknown listener "send-welcome-mail"')).toBe(true)
  })

  it('does not delay retries without a queue URL', async () => {
    const send = vi.fn()
    const handler = createSqsHandler(
      workerOf({
        'send-welcome-mail': () => {
          throw new Error('down')
        },
      }),
      { client: { send }, retryDelay: () => 10 }
    )
    await handler({
      Records: [
        recordOf(envelopeOf(), { eventSourceARN: undefined }),
        recordOf(envelopeOf(), { messageId: 'm2', eventSourceARN: 'invalid' }),
      ],
    })
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a value that is not a worker',
      {},
      {},
      'createSqsHandler(): expected a worker created by createWorker().',
    ],
    [
      'an unknown option',
      'worker',
      { visibilityTimeout: 30 },
      'createSqsHandler(): unknown option "visibilityTimeout".',
    ],
    [
      'an invalid dead-letter queue',
      'worker',
      { deadLetterQueueUrl: 'dlq' },
      'createSqsHandler(): deadLetterQueueUrl must be the URL of an SQS queue.',
    ],
    [
      'an invalid queue URL',
      'worker',
      { queueUrl: 'q' },
      'createSqsHandler(): queueUrl must be the URL of an SQS queue.',
    ],
    [
      'an invalid retry delay',
      'worker',
      { retryDelay: 10 },
      'createSqsHandler(): retryDelay must be a function.',
    ],
    [
      'an invalid logger',
      'worker',
      { logger: {} },
      'createSqsHandler(): logger must have info(), warn() and error() methods.',
    ],
  ])('rejects %s', (_, target, options, message) => {
    expect(() =>
      createSqsHandler(
        (target === 'worker' ? workerOf({}) : target) as never,
        options as never
      )
    ).toThrow(new TypeError(message))
  })
})

describe('SQS source', () => {
  const run = (
    source: ReturnType<typeof createSqsSource>,
    listeners: ReturnType<typeof listenerOf>[],
    logger = createLogger()
  ) => {
    const running = startWorker(createWorker({ listeners, logger }), source, {
      logger,
    })
    return { running, logger }
  }

  it('runs the listeners of the queue, and deletes the handled messages', async () => {
    const queue = newQueue()
    queue.queue().redrivePolicy = '{"maxReceiveCount":5}'
    const received: string[] = []
    const listeners = [
      listenerOf(
        'a',
        ({ payload }) => void received.push(payload.practitionerId)
      ),
    ]
    const events = createEventBus({
      transport: createSqsTransport({ queueUrl: queue.url, client }),
      listeners,
    })
    const { running, logger } = run(
      createSqsSource({ queueUrl: queue.url, client, waitTimeSeconds: 1 }),
      listeners
    )
    await events.emit(practitionerCreated, { practitionerId: '42' })
    await vi.waitFor(() => expect(received).toEqual(['42']))
    await vi.waitFor(() => expect(queue.queue().messages).toEqual([]))
    await running.stop()

    expect(callsOf(queue.url, 'ReceiveMessage')[0]?.input).toEqual({
      QueueUrl: queue.url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    })
    expect(callsOf(queue.url, 'GetQueueAttributes')[0]?.input).toEqual({
      QueueUrl: queue.url,
      AttributeNames: ['RedrivePolicy'],
    })
    expect(
      logger.entries.filter(
        ({ level }) => level === 'warn' || level === 'error'
      )
    ).toEqual([])
  })

  it('stops long polling at once', async () => {
    const queue = newQueue()
    const { running } = run(
      createSqsSource({
        queueUrl: queue.url,
        client,
        checkRedrivePolicy: false,
      }),
      []
    )
    await vi.waitFor(() =>
      expect(callsOf(queue.url, 'ReceiveMessage').length > 0).toBe(true)
    )
    const start = Date.now()
    await running.stop()
    expect(Date.now() - start).toBeLessThan(1000)
    expect(callsOf(queue.url, 'GetQueueAttributes').length > 0).toBe(false)
  })

  it('warns about a queue without dead-letter queue', async () => {
    const queue = newQueue()
    const { running, logger } = run(
      createSqsSource({ queueUrl: queue.url, client, waitTimeSeconds: 0 }),
      []
    )
    await vi.waitFor(() =>
      expect(logger.entries.some(({ level }) => level === 'warn')).toBe(true)
    )
    await running.stop()
    expect(logger.entries.find(({ level }) => level === 'warn')).toEqual({
      level: 'warn',
      message:
        'The SQS queue has no dead-letter queue: failed messages are retried until they expire',
      data: { queueUrl: queue.url },
    })
  })

  it('warns when the redrive policy cannot be read', async () => {
    const queue = newQueue()
    server.failNext(
      'GetQueueAttributes',
      'AccessDenied',
      'Not allowed.',
      403,
      queue.url
    )
    const { running, logger } = run(
      createSqsSource({ queueUrl: queue.url, client, waitTimeSeconds: 0 }),
      []
    )
    await vi.waitFor(() =>
      expect(logger.entries.some(({ level }) => level === 'warn')).toBe(true)
    )
    await running.stop()
    expect(logger.entries.find(({ level }) => level === 'warn')).toEqual({
      level: 'warn',
      message: 'Cannot read the redrive policy of the SQS queue',
      data: { queueUrl: queue.url, error: 'Not allowed.' },
    })
  })

  it('retries failed messages, and copies dead ones', async () => {
    const queue = newQueue()
    const dlq = newQueue('-dlq')
    queue.queue().redrivePolicy = '{}'
    const attempts: number[] = []
    const listeners = [
      listenerOf('flaky', ({ attempt }) => {
        attempts.push(attempt)
        if (attempt < 3) throw new Error('down')
      }),
    ]
    const { running } = run(
      createSqsSource({
        queueUrl: queue.url,
        client,
        waitTimeSeconds: 0,
        batchSize: 5,
        retryDelay: () => 0,
        deadLetterQueueUrl: dlq.url,
      }),
      listeners
    )
    const events = createEventBus({
      transport: createSqsTransport({ queueUrl: queue.url, client }),
      listeners,
    })
    await events.emit(practitionerCreated, { practitionerId: '1' })
    queue.queue().messages.push({
      id: 'dead',
      body: JSON.stringify(envelopeOf({ listener: 'removed' })),
      attributes: {},
      receiveCount: 0,
      visibleAt: 0,
      receipt: undefined,
    })
    await vi.waitFor(() => expect(attempts).toEqual([1, 2, 3]))
    await vi.waitFor(() => expect(queue.queue().messages).toEqual([]))
    await running.stop()
    expect(dlq.queue().messages).toHaveLength(1)
    expect(callsOf(queue.url, 'ReceiveMessage')[0]?.input).toMatchObject({
      MaxNumberOfMessages: 5,
      WaitTimeSeconds: 0,
    })
  })

  it('extends the visibility of long messages', async () => {
    const queue = newQueue()
    queue.queue().redrivePolicy = '{}'
    let done = false
    const listeners = [
      listenerOf('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1300))
        done = true
      }),
    ]
    const { running } = run(
      createSqsSource({
        queueUrl: queue.url,
        client,
        waitTimeSeconds: 0,
        visibilityTimeout: 2,
      }),
      listeners
    )
    await createEventBus({
      transport: createSqsTransport({ queueUrl: queue.url, client }),
      listeners,
    }).emit(practitionerCreated, { practitionerId: '1' })
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 3000 })
    await running.stop()
    expect(callsOf(queue.url, 'ReceiveMessage')[0]?.input).toMatchObject({
      VisibilityTimeout: 2,
    })
    expect(callsOf(queue.url, 'ChangeMessageVisibility').length).toBe(1)
    // The heartbeat stops with the message.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(callsOf(queue.url, 'ChangeMessageVisibility').length).toBe(1)
  })

  it('logs heartbeat failures', async () => {
    const queue = newQueue()
    queue.queue().redrivePolicy = '{}'
    const logger = createLogger()
    let done = false
    const listeners = [
      listenerOf('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 600))
        done = true
      }),
    ]
    server.failNext(
      'ChangeMessageVisibility',
      'ReceiptHandleIsInvalid',
      'Expired.',
      400,
      queue.url
    )
    const { running } = run(
      createSqsSource({
        queueUrl: queue.url,
        client,
        waitTimeSeconds: 0,
        visibilityTimeout: 1,
      }),
      listeners,
      logger
    )
    await createEventBus({
      transport: createSqsTransport({ queueUrl: queue.url, client }),
      listeners,
    }).emit(practitionerCreated, { practitionerId: '1' })
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 3000 })
    await running.stop()
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'Cannot extend the visibility of the message',
      data: { queueUrl: queue.url, error: 'Expired.' },
    })
  })

  it('waits and retries when receiving fails', async () => {
    const queue = newQueue()
    queue.queue().redrivePolicy = '{}'
    // A 400 error: the SDK does not retry it.
    server.failNext(
      'ReceiveMessage',
      'QueueDoesNotExist',
      'Oops.',
      400,
      queue.url
    )
    const received: string[] = []
    const listeners = [
      listenerOf(
        'a',
        ({ payload }) => void received.push(payload.practitionerId)
      ),
    ]
    const { running, logger } = run(
      createSqsSource({ queueUrl: queue.url, client, waitTimeSeconds: 0 }),
      listeners
    )
    await createEventBus({
      transport: createSqsTransport({ queueUrl: queue.url, client }),
      listeners,
    }).emit(practitionerCreated, { practitionerId: '7' })
    await vi.waitFor(() => expect(received).toEqual(['7']), { timeout: 4000 })
    await running.stop()
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Cannot receive SQS messages',
      data: { queueUrl: queue.url, error: 'Oops.', retryInMs: 1000 },
    })
  })

  it('logs deletions that fail', async () => {
    const queue = newQueue()
    queue.queue().redrivePolicy = '{}'
    let receives = 0
    let deletes = 0
    const send = vi.fn(
      async (command: { constructor: { name: string }; input: object }) => {
        const action = command.constructor.name
        if (action === 'ReceiveMessageCommand') {
          receives += 1
          if (receives > 2) {
            await new Promise((resolve) => setTimeout(resolve, 20))
            return {}
          }
          return {
            Messages: [
              {
                Body: JSON.stringify(envelopeOf({ listener: 'a' })),
                ReceiptHandle: 'r1',
              },
            ],
          }
        }
        if (action === 'DeleteMessageBatchCommand') {
          deletes += 1
          if (deletes === 1) return { Failed: [{ Id: '0', Message: 'gone' }] }
          throw new Error('network down')
        }
        return { Attributes: { RedrivePolicy: '{}' } }
      }
    )
    const listeners = [listenerOf('a', () => {})]
    const { running, logger } = run(
      createSqsSource({ queueUrl: queue.url, client: { send } }),
      listeners
    )
    await vi.waitFor(() =>
      expect(
        logger.entries.filter(({ level }) => level === 'error')
      ).toHaveLength(2)
    )
    await running.stop()
    expect(logger.entries.filter(({ level }) => level === 'error')).toEqual([
      {
        level: 'error',
        message:
          'Cannot delete handled SQS messages: they will be delivered again',
        data: { queueUrl: queue.url, failed: 1 },
      },
      {
        level: 'error',
        message:
          'Cannot delete handled SQS messages: they will be delivered again',
        data: { queueUrl: queue.url, error: 'network down' },
      },
    ])
    expect(
      send.mock.calls.find(
        ([command]) => command.constructor.name === 'DeleteMessageBatchCommand'
      )?.[0].input
    ).toEqual({
      QueueUrl: queue.url,
      Entries: [{ Id: '0', ReceiptHandle: 'r1' }],
    })
  })

  it('uses its own logger when given one', async () => {
    const queue = newQueue()
    const own = createLogger()
    const { running, logger } = run(
      createSqsSource({
        queueUrl: queue.url,
        client,
        waitTimeSeconds: 0,
        logger: own,
      }),
      []
    )
    await vi.waitFor(() => expect(own.entries.length).toBeGreaterThan(0))
    await running.stop()
    expect(logger.entries.filter(({ level }) => level === 'warn')).toEqual([])
  })

  it.each([
    [
      'no queue URL',
      {},
      'createSqsSource(): queueUrl must be the URL of an SQS queue.',
    ],
    [
      'an unknown option',
      { queueUrl: 'https://x/1/q', concurrency: 2 },
      'createSqsSource(): unknown option "concurrency".',
    ],
    [
      'a long poll over 20 seconds',
      { queueUrl: 'https://x/1/q', waitTimeSeconds: 21 },
      'createSqsSource(): waitTimeSeconds must be an integer from 0 to 20.',
    ],
    [
      'a negative long poll',
      { queueUrl: 'https://x/1/q', waitTimeSeconds: -1 },
      'createSqsSource(): waitTimeSeconds must be an integer from 0 to 20.',
    ],
    [
      'a batch over 10',
      { queueUrl: 'https://x/1/q', batchSize: 11 },
      'createSqsSource(): batchSize must be an integer from 1 to 10.',
    ],
    [
      'an empty batch',
      { queueUrl: 'https://x/1/q', batchSize: 0 },
      'createSqsSource(): batchSize must be an integer from 1 to 10.',
    ],
    [
      'a batch size that is not an integer',
      { queueUrl: 'https://x/1/q', batchSize: 2.5 },
      'createSqsSource(): batchSize must be an integer from 1 to 10.',
    ],
    [
      'a visibility of 0',
      { queueUrl: 'https://x/1/q', visibilityTimeout: 0 },
      'createSqsSource(): visibilityTimeout must be an integer from 1 to 43200.',
    ],
    [
      'a visibility over 12 hours',
      { queueUrl: 'https://x/1/q', visibilityTimeout: 43_201 },
      'createSqsSource(): visibilityTimeout must be an integer from 1 to 43200.',
    ],
    [
      'an invalid redrive check',
      { queueUrl: 'https://x/1/q', checkRedrivePolicy: 'yes' },
      'createSqsSource(): checkRedrivePolicy must be a boolean.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createSqsSource(options as never)).toThrow(
      new TypeError(message)
    )
  })

  it('accepts the limits', () => {
    expect(
      createSqsSource({
        queueUrl: 'https://x/1/q',
        waitTimeSeconds: 0,
        batchSize: 1,
        visibilityTimeout: 43_200,
        checkRedrivePolicy: true,
      }).kind
    ).toBe('aws-sqs')
  })
})
