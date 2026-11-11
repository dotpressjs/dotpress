import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
  createCloudflarePullSource,
  createCloudflareQueueHandler,
  createCloudflareQueueTransport,
  decodePulledBody,
  type CloudflareQueueMessage,
} from '../src/transports/cloudflare-queues.js'
import { startCloudflareServer } from './cloudflare-queues-server.js'
import { createLogger, envelopeOf, userCreated } from './support.js'

const listenerOf = (
  name: string,
  handle: ListenerHandler<{ userId: string }>
) => defineListener(userCreated, { name, handle })

const bindingMock = () => ({
  sendBatch: vi.fn<(messages: Iterable<{ body: unknown }>) => Promise<unknown>>(
    async () => ({})
  ),
})

describe('Cloudflare Queues transport (binding)', () => {
  it('sends JSON messages through the binding', async () => {
    const binding = bindingMock()
    const events = createEventBus({
      transport: createCloudflareQueueTransport({ queue: binding }),
      listeners: [listenerOf('a', () => {}), listenerOf('b', () => {})],
    })
    const { messages } = await events.emit(
      userCreated,
      { userId: '42' },
      { delay: 60 }
    )
    expect(binding.sendBatch).toHaveBeenCalledExactlyOnceWith([
      {
        body: expect.objectContaining({ id: messages[0]?.id, listener: 'a' }),
        contentType: 'json',
        delaySeconds: 60,
      },
      {
        body: expect.objectContaining({ id: messages[1]?.id, listener: 'b' }),
        contentType: 'json',
        delaySeconds: 60,
      },
    ])
  })

  it('resolves the binding when sending', async () => {
    const binding = bindingMock()
    const resolve = vi.fn(() => binding)
    const transport = createCloudflareQueueTransport({ queue: resolve })
    expect(transport.kind).toBe('cloudflare-queues')
    expect(resolve).not.toHaveBeenCalled()
    await transport.send([envelopeOf()], { delay: undefined })
    expect(resolve).toHaveBeenCalledOnce()
    expect(binding.sendBatch.mock.calls[0]?.[0]).toEqual([
      { body: envelopeOf(), contentType: 'json' },
    ])
  })

  it('sends batches of 100 messages and 256 KB, and rejects messages over 128 KB', async () => {
    const binding = bindingMock()
    const transport = createCloudflareQueueTransport({ queue: binding })
    const sized = (index: number, size: number) => {
      const envelope = { ...envelopeOf({ id: `id-${index}` }), payload: '' }
      const padding = size - JSON.stringify(envelope).length
      return { ...envelope, payload: 'x'.repeat(padding) }
    }
    const small = Array.from({ length: 150 }, (_, index) => sized(index, 1000))
    await transport.send(small, { delay: undefined })
    expect(
      binding.sendBatch.mock.calls.map(([batch]) => [...batch].length)
    ).toEqual([100, 50])

    binding.sendBatch.mockClear()
    const error = await transport
      .send(
        [
          sized(1, 100_000),
          sized(2, 100_000),
          sized(3, 100_000),
          sized(4, 127_900),
          sized(5, 127_901),
        ],
        { delay: undefined }
      )
      .catch((e: unknown) => e)
    expect(
      binding.sendBatch.mock.calls.map(([batch]) => [...batch].length)
    ).toEqual([2, 2])
    expect(error).toMatchObject({
      failed: [
        {
          id: 'id-5',
          error: expect.objectContaining({
            message:
              'Cloudflare Queues accepts messages of at most 127900 bytes (128 KB with its metadata), got 127901.',
          }),
        },
      ],
    })
  })

  it('rejects delays over 24 hours', async () => {
    const binding = bindingMock()
    const events = createEventBus({
      transport: createCloudflareQueueTransport({ queue: binding }),
      listeners: [listenerOf('a', () => {})],
    })
    const error = await events
      .emit(userCreated, { userId: '1' }, { delay: 86_401 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EventEmitError)
    expect((error as Error).cause).toEqual(
      new RangeError(
        'Cloudflare Queues accepts delays of at most 86400 seconds, got 86401.'
      )
    )
    await events.emit(userCreated, { userId: '1' }, { delay: 86_400 })
    expect(binding.sendBatch).toHaveBeenCalledOnce()
  })

  it('reports binding failures', async () => {
    const binding = bindingMock()
    binding.sendBatch.mockRejectedValueOnce(new Error('Queue send failed'))
    await expect(
      createCloudflareQueueTransport({ queue: binding }).send([envelopeOf()], {
        delay: undefined,
      })
    ).rejects.toMatchObject({
      failed: [{ id: envelopeOf().id, error: new Error('Queue send failed') }],
    })
  })

  it.each([
    [
      'not an object',
      null,
      'createCloudflareQueueTransport(): expected an object of options.',
    ],
    [
      'an unknown option',
      { queue: bindingMock(), name: 'q' },
      'createCloudflareQueueTransport(): unknown option "name".',
    ],
    [
      'a binding without sendBatch()',
      { queue: {} },
      'createCloudflareQueueTransport(): queue must be a queue binding, or a function returning it.',
    ],
    [
      'a binding and REST options',
      { queue: bindingMock(), accountId: 'a' },
      'createCloudflareQueueTransport(): set queue, or the REST API options, not both.',
    ],
    [
      'no account',
      { queueId: 'q', apiToken: 't' },
      'createCloudflareQueueTransport(): accountId must be a non-empty string.',
    ],
    [
      'no queue ID',
      { accountId: 'a', apiToken: 't' },
      'createCloudflareQueueTransport(): queueId must be a non-empty string.',
    ],
    [
      'no token',
      { accountId: 'a', queueId: 'q' },
      'createCloudflareQueueTransport(): apiToken must be a non-empty string.',
    ],
    [
      'an invalid base URL',
      { accountId: 'a', queueId: 'q', apiToken: 't', baseUrl: 'api' },
      'createCloudflareQueueTransport(): baseUrl must be an http(s) URL.',
    ],
    [
      'an invalid fetch',
      { accountId: 'a', queueId: 'q', apiToken: 't', fetch: 1 },
      'createCloudflareQueueTransport(): fetch must be a function.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createCloudflareQueueTransport(options as never)).toThrow(
      new TypeError(message)
    )
  })
})

describe('Cloudflare Queues transport (REST API)', () => {
  const rest = (fetchMock: typeof fetch) =>
    createCloudflareQueueTransport({
      accountId: 'acc 1',
      queueId: 'queue-1',
      apiToken: 'token',
      baseUrl: 'https://api.example.com/client/v4/',
      fetch: fetchMock,
    })

  it('pushes batches of JSON messages', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ success: true, result: {} }))
    )
    await rest(fetchMock).send([envelopeOf()], { delay: 30 })
    await rest(fetchMock).send([envelopeOf()], { delay: undefined })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(
      'https://api.example.com/client/v4/accounts/acc%201/queues/queue-1/messages/batch'
    )
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
    })
    expect(JSON.parse(init?.body as string)).toEqual({
      messages: [
        { body: envelopeOf(), content_type: 'json', delay_seconds: 30 },
      ],
    })
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      messages: [{ body: envelopeOf(), content_type: 'json' }],
    })
  })

  it.each([
    [
      'API errors',
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [
              { code: 10_000, message: 'Authentication error' },
              { code: 7003, message: 'Could not route' },
            ],
          }),
          { status: 403, statusText: 'Forbidden' }
        ),
      'Cloudflare Queues API: 403 10000: Authentication error; 7003: Could not route',
    ],
    [
      'a failure in a successful response',
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1, message: 'Nope' }],
          })
        ),
      'Cloudflare Queues API: 200 1: Nope',
    ],
    [
      'a response that is not JSON',
      () =>
        new Response('Bad gateway', { status: 502, statusText: 'Bad Gateway' }),
      'Cloudflare Queues API: 502 Bad Gateway',
    ],
    [
      'errors that are not a list',
      () =>
        new Response(JSON.stringify({ success: false, errors: 'x' }), {
          status: 500,
        }),
      'Cloudflare Queues API: 500',
    ],
  ])('reports %s', async (_, response, message) => {
    const error = await rest(vi.fn<typeof fetch>(async () => response()))
      .send([envelopeOf()], { delay: undefined })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ failed: [{ error: new Error(message) }] })
  })
})

describe('Cloudflare Queues handler', () => {
  const messageOf = (envelope: Envelope, attempts = 1) => {
    const message = {
      id: `m-${envelope.listener}`,
      body: envelope,
      attempts,
      ack: vi.fn(),
      retry: vi.fn(),
    } satisfies CloudflareQueueMessage
    return message
  }

  const workerOf = (
    handlers: Record<string, ListenerHandler<{ userId: string }>>
  ) =>
    createWorker({
      listeners: Object.entries(handlers).map(([name, handle]) =>
        listenerOf(name, handle)
      ),
    })

  it('acknowledges or retries each message', async () => {
    const attempts: number[] = []
    const handler = createCloudflareQueueHandler(
      workerOf({
        ok: ({ attempt }) => void attempts.push(attempt),
        failing: () => {
          throw new Error('down')
        },
      })
    )
    const ok = messageOf(envelopeOf({ listener: 'ok' }), 2)
    const failing = messageOf(envelopeOf({ listener: 'failing' }))
    const dead = messageOf(envelopeOf({ listener: 'unknown' }))
    await handler({ queue: 'events', messages: [ok, failing, dead] })
    expect(attempts).toEqual([2])
    expect(ok.ack).toHaveBeenCalledOnce()
    expect(ok.retry).not.toHaveBeenCalled()
    expect(failing.retry).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(failing.ack).not.toHaveBeenCalled()
    // Without dead-letter queue binding: retried until max_retries.
    expect(dead.retry).toHaveBeenCalledOnce()
  })

  it('delays retries', async () => {
    const handler = createCloudflareQueueHandler(
      workerOf({
        failing: () => {
          throw new Error('down')
        },
      }),
      {
        retryDelay: (attempt) =>
          attempt === 1 ? -1 : attempt === 2 ? 12.4 : 1e9,
      }
    )
    const messages = [1, 2, 3].map((attempts) =>
      messageOf(envelopeOf({ listener: 'failing' }), attempts)
    )
    await handler({ queue: 'events', messages })
    expect(messages.map(({ retry }) => retry.mock.calls[0]?.[0])).toEqual([
      { delaySeconds: 0 },
      { delaySeconds: 12 },
      { delaySeconds: 86_400 },
    ])
  })

  it('does not send failed listeners to the dead-letter queue', async () => {
    const dlq = bindingMock()
    const handler = createCloudflareQueueHandler(
      workerOf({
        failing: () => {
          throw new Error('down')
        },
      }),
      { deadLetterQueue: dlq }
    )
    const failing = messageOf(envelopeOf({ listener: 'failing' }))
    await handler({ queue: 'events', messages: [failing] })
    expect(dlq.sendBatch).not.toHaveBeenCalled()
    expect(failing.retry).toHaveBeenCalledOnce()
    expect(failing.ack).not.toHaveBeenCalled()
  })

  it('sends dead messages to the dead-letter queue', async () => {
    const dlq = bindingMock()
    const handler = createCloudflareQueueHandler(workerOf({}), {
      deadLetterQueue: () => dlq,
    })
    const dead = messageOf(envelopeOf())
    await handler({ queue: 'events', messages: [dead] })
    expect(dlq.sendBatch).toHaveBeenCalledExactlyOnceWith([
      { body: envelopeOf(), contentType: 'json' },
    ])
    expect(dead.ack).toHaveBeenCalledOnce()
    expect(dead.retry).not.toHaveBeenCalled()
  })

  it('retries dead messages when the dead-letter queue fails', async () => {
    const dlq = bindingMock()
    dlq.sendBatch.mockRejectedValueOnce(new Error('down'))
    const handler = createCloudflareQueueHandler(workerOf({}), {
      deadLetterQueue: dlq,
    })
    const dead = messageOf(envelopeOf())
    await handler({ queue: 'events', messages: [dead] })
    expect(dead.retry).toHaveBeenCalledOnce()
    expect(dead.ack).not.toHaveBeenCalled()
  })

  it('handles empty batches', async () => {
    const handler = createCloudflareQueueHandler(workerOf({}))
    await expect(
      handler({ queue: 'events', messages: [] })
    ).resolves.toBeUndefined()
    await expect(handler(undefined as never)).resolves.toBeUndefined()
  })

  it.each([
    [
      'a value that is not a worker',
      {},
      {},
      'createCloudflareQueueHandler(): expected a worker created by createWorker().',
    ],
    [
      'an unknown option',
      'worker',
      { maxRetries: 3 },
      'createCloudflareQueueHandler(): unknown option "maxRetries".',
    ],
    [
      'an invalid retry delay',
      'worker',
      { retryDelay: 5 },
      'createCloudflareQueueHandler(): retryDelay must be a function.',
    ],
    [
      'an invalid dead-letter queue',
      'worker',
      { deadLetterQueue: 'dlq' },
      'createCloudflareQueueHandler(): deadLetterQueue must be a queue binding, or a function returning it.',
    ],
  ])('rejects %s', (_, target, options, message) => {
    expect(() =>
      createCloudflareQueueHandler(
        (target === 'worker' ? workerOf({}) : target) as never,
        options as never
      )
    ).toThrow(new TypeError(message))
  })
})

describe('decodePulledBody()', () => {
  it('decodes base64 JSON, and keeps plain JSON', () => {
    const json = JSON.stringify(envelopeOf({ payload: { name: 'Zoë' } }))
    expect(decodePulledBody(Buffer.from(json).toString('base64'))).toBe(json)
    expect(decodePulledBody(json)).toBe(json)
    expect(decodePulledBody(`  ${json}`)).toBe(`  ${json}`)
    expect(decodePulledBody('not base64!')).toBe('not base64!')
    expect(decodePulledBody({ already: 'parsed' })).toEqual({
      already: 'parsed',
    })
  })
})

describe('Cloudflare Queues pull source', () => {
  let server: Awaited<ReturnType<typeof startCloudflareServer>>
  let count = 0

  beforeAll(async () => {
    server = await startCloudflareServer()
  })
  afterAll(() => server.close())

  const setup = (
    listeners: ReturnType<typeof listenerOf>[],
    options: Record<string, unknown> = {}
  ) => {
    count += 1
    const queueId = `queue-${count}`
    const api = {
      accountId: 'acc',
      queueId,
      apiToken: 'token',
      baseUrl: server.url,
    }
    const events = createEventBus({
      transport: createCloudflareQueueTransport(api),
      listeners,
    })
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners, logger }),
      createCloudflarePullSource({ ...api, pollInterval: 10, ...options }),
      { logger }
    )
    return { events, running, logger, queueId }
  }

  it('runs the listeners of the queue, and acknowledges the messages', async () => {
    const received: string[] = []
    const { events, running, queueId } = setup([
      listenerOf('a', ({ payload }) => void received.push(payload.userId)),
    ])
    await events.emit(userCreated, { userId: 'Zoë' })
    await vi.waitFor(() => expect(received).toEqual(['Zoë']))
    await vi.waitFor(() => expect(server.queue(queueId)).toEqual([]))
    await running.stop()
    const pull = server.calls.find(({ path }) =>
      path.endsWith(`${queueId}/messages/pull`)
    )
    expect(pull).toEqual({
      path: `/client/v4/accounts/acc/queues/${queueId}/messages/pull`,
      body: { batch_size: 10, visibility_timeout_ms: 30_000 },
      auth: 'Bearer token',
    })
    // Empty pulls are not acknowledged.
    const acks = server.calls.filter(({ path }) =>
      path.endsWith(`${queueId}/messages/ack`)
    )
    expect(acks).toEqual([
      expect.objectContaining({
        body: { acks: [{ lease_id: expect.any(String) }], retries: [] },
      }),
    ])
  })

  it('waits 1 second before pulling an empty queue again', async () => {
    count += 1
    const queueId = `queue-${count}`
    const running = startWorker(
      createWorker({ listeners: [] }),
      createCloudflarePullSource({
        accountId: 'acc',
        queueId,
        apiToken: 'token',
        baseUrl: server.url,
      })
    )
    const pulls = () =>
      server.calls.filter(({ path }) =>
        path.endsWith(`${queueId}/messages/pull`)
      )
    await vi.waitFor(() => expect(pulls()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(pulls()).toHaveLength(1)
    await vi.waitFor(() => expect(pulls()).toHaveLength(2), { timeout: 1000 })
    await running.stop()
  })

  it('waits 1 second again after a successful pull', async () => {
    const { running, queueId, logger } = setup([])
    server.failNext(queueId, 'pull', 503, 'Down')
    const errors = () =>
      logger.entries.filter(
        ({ message }) => message === 'Cannot pull Cloudflare Queues messages'
      )
    await vi.waitFor(() => expect(errors()).toHaveLength(1))
    const pulls = server.calls.filter(({ path }) =>
      path.endsWith(`${queueId}/messages/pull`)
    ).length
    await vi.waitFor(
      () =>
        expect(
          server.calls.filter(({ path }) =>
            path.endsWith(`${queueId}/messages/pull`)
          ).length
        ).toBeGreaterThan(pulls),
      { timeout: 2000 }
    )
    server.failNext(queueId, 'pull', 503, 'Down')
    await vi.waitFor(() => expect(errors()).toHaveLength(2), { timeout: 2000 })
    expect(
      errors().map(({ data }) => (data as { retryInMs: number }).retryInMs)
    ).toEqual([1000, 1000])
    await running.stop()
  })

  it('reads plain JSON bodies too', async () => {
    const plain = await startCloudflareServer({ base64: false })
    const received: string[] = []
    const listeners = [
      listenerOf('a', ({ payload }) => void received.push(payload.userId)),
    ]
    const api = {
      accountId: 'acc',
      queueId: 'q',
      apiToken: 't',
      baseUrl: plain.url,
    }
    await createEventBus({
      transport: createCloudflareQueueTransport(api),
      listeners,
    }).emit(userCreated, { userId: '7' })
    const running = startWorker(
      createWorker({ listeners }),
      createCloudflarePullSource({ ...api, pollInterval: 10 })
    )
    await vi.waitFor(() => expect(received).toEqual(['7']))
    await running.stop()
    await plain.close()
  })

  it('retries failed messages, and copies dead ones', async () => {
    const attempts: number[] = []
    const { events, running, queueId } = setup(
      [
        listenerOf('flaky', ({ attempt }) => {
          attempts.push(attempt)
          if (attempt < 3) throw new Error('down')
        }),
      ],
      {
        retryDelay: () => 0,
        deadLetterQueueId: 'dlq-1',
        batchSize: 5,
        visibilityTimeoutMs: 1000,
      }
    )
    await events.emit(userCreated, { userId: '1' })
    server.queue(queueId).push({
      id: 'dead',
      body: envelopeOf({ listener: 'removed' }),
      attempts: 0,
      visibleAt: 0,
      leaseId: undefined,
    })
    await vi.waitFor(() => expect(attempts).toEqual([1, 2, 3]))
    await vi.waitFor(() => expect(server.queue(queueId)).toEqual([]))
    await running.stop()
    expect(server.queue('dlq-1')).toEqual([
      expect.objectContaining({ body: envelopeOf({ listener: 'removed' }) }),
    ])
    const acks = server.calls.filter(({ path }) =>
      path.endsWith(`${queueId}/messages/ack`)
    )
    expect(
      acks.some(({ body }) =>
        (body.retries as { delay_seconds?: number }[]).some(
          (retry) => retry.delay_seconds === 0
        )
      )
    ).toBe(true)
    expect(
      server.calls.find(({ path }) => path.endsWith(`${queueId}/messages/pull`))
        ?.body
    ).toEqual({
      batch_size: 5,
      visibility_timeout_ms: 1000,
    })
  })

  it('retries dead messages without dead-letter queue, and when it fails', async () => {
    const { running, queueId, logger } = setup([listenerOf('a', () => {})], {
      deadLetterQueueId: 'dlq-failing',
    })
    server.failNext(
      'dlq-failing',
      'batch',
      500,
      '{"success":false,"errors":[{"code":1,"message":"Down"}]}'
    )
    server.queue(queueId).push({
      id: 'dead',
      body: envelopeOf({ listener: 'removed' }),
      attempts: 0,
      visibleAt: 0,
      leaseId: undefined,
    })
    await vi.waitFor(() =>
      expect(logger.entries).toContainEqual({
        level: 'error',
        message: 'Cannot copy the message to the dead-letter queue',
        data: {
          deadLetterQueueId: 'dlq-failing',
          error: 'Cloudflare Queues API: 500 1: Down',
        },
      })
    )
    await vi.waitFor(() => expect(server.queue('dlq-failing')).toHaveLength(1))
    await running.stop()
  })

  it('logs pull and acknowledgment failures, and goes on', async () => {
    const received: string[] = []
    // A short lease: the message comes back after the failed acknowledgment.
    const { events, running, queueId, logger } = setup(
      [listenerOf('a', ({ payload }) => void received.push(payload.userId))],
      { visibilityTimeoutMs: 200 }
    )
    server.failNext(queueId, 'pull', 503, 'Service unavailable')
    server.failNext(queueId, 'ack', 500, '{"success":false,"errors":[]}')
    await events.emit(userCreated, { userId: '1' })
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2), {
      timeout: 4000,
    })
    await running.stop()
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Cannot pull Cloudflare Queues messages',
      data: {
        error: 'Cloudflare Queues API: 503 Service Unavailable',
        retryInMs: 1000,
      },
    })
    expect(logger.entries).toContainEqual({
      level: 'error',
      message:
        'Cannot acknowledge Cloudflare Queues messages: they will be delivered again',
      data: { error: 'Cloudflare Queues API: 500 Internal Server Error' },
    })
  })

  it('stops while waiting', async () => {
    const { running } = setup([], { pollInterval: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const start = Date.now()
    await running.stop()
    expect(Date.now() - start).toBeLessThan(500)
  })

  it.each([
    [
      'no account',
      {},
      'createCloudflarePullSource(): accountId must be a non-empty string.',
    ],
    [
      'an unknown option',
      { accountId: 'a', queueId: 'q', apiToken: 't', queue: {} },
      'createCloudflarePullSource(): unknown option "queue".',
    ],
    [
      'a batch over 100',
      { accountId: 'a', queueId: 'q', apiToken: 't', batchSize: 101 },
      'createCloudflarePullSource(): batchSize must be an integer from 1 to 100.',
    ],
    [
      'an empty batch',
      { accountId: 'a', queueId: 'q', apiToken: 't', batchSize: 0 },
      'createCloudflarePullSource(): batchSize must be an integer from 1 to 100.',
    ],
    [
      'a lease over 12 hours',
      {
        accountId: 'a',
        queueId: 'q',
        apiToken: 't',
        visibilityTimeoutMs: 43_200_001,
      },
      'createCloudflarePullSource(): visibilityTimeoutMs must be an integer from 1 to 43200000.',
    ],
    [
      'a lease of 0',
      { accountId: 'a', queueId: 'q', apiToken: 't', visibilityTimeoutMs: 0 },
      'createCloudflarePullSource(): visibilityTimeoutMs must be an integer from 1 to 43200000.',
    ],
    [
      'a negative poll interval',
      { accountId: 'a', queueId: 'q', apiToken: 't', pollInterval: -1 },
      'createCloudflarePullSource(): pollInterval must be an integer from 0 to 3600000.',
    ],
    [
      'a poll interval that is not an integer',
      { accountId: 'a', queueId: 'q', apiToken: 't', pollInterval: 1.5 },
      'createCloudflarePullSource(): pollInterval must be an integer from 0 to 3600000.',
    ],
    [
      'an invalid retry delay',
      { accountId: 'a', queueId: 'q', apiToken: 't', retryDelay: 1 },
      'createCloudflarePullSource(): retryDelay must be a function.',
    ],
    [
      'an empty dead-letter queue',
      { accountId: 'a', queueId: 'q', apiToken: 't', deadLetterQueueId: '' },
      'createCloudflarePullSource(): deadLetterQueueId must be a non-empty string.',
    ],
  ])('rejects %s', (_, options, message) => {
    expect(() => createCloudflarePullSource(options as never)).toThrow(
      new TypeError(message)
    )
  })

  it('accepts the limits', () => {
    expect(
      createCloudflarePullSource({
        accountId: 'a',
        queueId: 'q',
        apiToken: 't',
        batchSize: 100,
        visibilityTimeoutMs: 43_200_000,
        pollInterval: 0,
      }).kind
    ).toBe('cloudflare-queues')
  })
})
