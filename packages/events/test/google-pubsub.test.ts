import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PubSub } from '@google-cloud/pubsub'
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
  createPubSubPullSource,
  createPubSubPushHandler,
  createPubSubTransport,
} from '../src/transports/google-pubsub.js'
import { startPubSubServer } from './google-pubsub-server.js'
import { createLogger, envelopeOf, userCreated } from './support.js'

// Requests of several megabytes, close to the size limits: slow on a busy
// CI runner (the default timeout is 5 seconds).
const LARGE_TIMEOUT = { timeout: 30_000 }

const listenerOf = (
  name: string,
  handle: ListenerHandler<{ userId: string }>
) => defineListener(userCreated, { name, handle })

const TOPIC = 'projects/test-project/topics/events'
const DLQ = 'projects/test-project/topics/events-dlq'
const AUDIENCE = 'https://api.example.com/pubsub'
const ACCOUNT = 'pubsub-push@test-project.iam.gserviceaccount.com'

let server: Awaited<ReturnType<typeof startPubSubServer>>
beforeAll(async () => {
  server = await startPubSubServer()
})
afterAll(() => server.close())
afterEach(() => {
  server.reset()
  vi.doUnmock('google-auth-library')
  vi.doUnmock('jose')
  vi.doUnmock('@google-cloud/pubsub')
  vi.resetModules()
})

const base64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64')

describe('Pub/Sub transport', () => {
  it('publishes a message per listener, with its attributes', async () => {
    const getAccessToken = vi.fn(async () => 'token-1')
    const events = createEventBus({
      transport: createPubSubTransport({
        topic: TOPIC,
        getAccessToken,
        baseUrl: `${server.url}/`,
      }),
      listeners: [listenerOf('a', () => {}), listenerOf('b', () => {})],
    })
    const before = server.calls.length
    const { messages } = await events.emit(userCreated, {
      userId: '42',
    })
    expect(server.calls.slice(before)).toEqual([
      {
        path: `/v1/${TOPIC}:publish`,
        auth: 'Bearer token-1',
        bytes: expect.any(Number),
      },
    ])
    expect(getAccessToken).toHaveBeenCalledOnce()
    const published = server.published(TOPIC).slice(-2)
    expect(published.map(({ attributes }) => attributes)).toEqual([
      { event: 'user.created', listener: 'a' },
      { event: 'user.created', listener: 'b' },
    ])
    expect(server.envelopes(TOPIC).slice(-2)).toEqual([
      expect.objectContaining({ id: messages[0]?.id, listener: 'a' }),
      expect.objectContaining({ id: messages[1]?.id, listener: 'b' }),
    ])
  })

  it('publishes without authentication to an emulator', async () => {
    const transport = createPubSubTransport({
      topic: TOPIC,
      getAccessToken: false,
      baseUrl: server.url,
    })
    expect(transport.kind).toBe('google-pubsub')
    await transport.send([envelopeOf()], { delay: undefined })
    expect(server.calls.at(-1)?.auth).toBeUndefined()
  })

  it('encodes UTF-8 payloads', async () => {
    const transport = createPubSubTransport({
      topic: TOPIC,
      getAccessToken: false,
      baseUrl: server.url,
    })
    const envelope = envelopeOf({ payload: { name: 'Zoë ✓ 😀' } })
    await transport.send([envelope], { delay: 0 })
    expect(server.envelopes(TOPIC).at(-1)).toEqual(envelope)
  })

  it('refuses delays', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const transport = createPubSubTransport({
      topic: TOPIC,
      getAccessToken: false,
      fetch,
    })
    await expect(transport.send([envelopeOf()], { delay: 60 })).rejects.toThrow(
      new RangeError(
        'Pub/Sub has no delayed delivery: emit without delay, or use another transport.'
      )
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it(
    'publishes batches of 1,000 messages and 10 MB, and rejects larger messages',
    LARGE_TIMEOUT,
    async () => {
      const sizes: number[] = []
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const { messages } = JSON.parse(String(init?.body)) as {
          messages: unknown[]
        }
        sizes.push(messages.length)
        return Response.json({ messageIds: [] })
      })
      const transport = createPubSubTransport({
        topic: TOPIC,
        getAccessToken: false,
        fetch,
      })
      const many = Array.from({ length: 2500 }, (_, index) =>
        envelopeOf({ id: `id-${index}` })
      )
      await transport.send(many, { delay: undefined })
      expect(sizes).toEqual([1000, 1000, 500])

      // Base64 data takes 4/3 of the JSON: 2 MB of payload, about 2.7 MB.
      sizes.length = 0
      const big = (id: string, size: number) =>
        envelopeOf({ id, payload: { userId: 'x'.repeat(size) } })
      const error = await transport
        .send(
          [
            big('a', 2_000_000),
            big('b', 2_000_000),
            big('c', 2_000_000),
            big('d', 2_000_000),
            big('huge', 7_600_000),
          ],
          { delay: undefined }
        )
        .catch((caught: unknown) => caught)
      expect(sizes).toEqual([3, 1])
      expect(error).toMatchObject({
        name: 'PartialSendError',
        failed: [{ id: 'huge', error: expect.any(RangeError) }],
      })
      const { failed } = error as { failed: { error: Error }[] }
      expect(failed[0]?.error.message).toMatch(
        /^Pub\/Sub accepts publish requests of at most 10000000 bytes \(data base64-encoded\), got 10133\d{3} for one message\.$/
      )
    }
  )

  it('keeps messages up to the limit of a request', LARGE_TIMEOUT, async () => {
    const lengths: number[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      lengths.push(String(init?.body).length)
      return Response.json({ messageIds: [] })
    })
    const transport = createPubSubTransport({
      topic: TOPIC,
      getAccessToken: false,
      fetch,
    })
    const envelope = envelopeOf({ payload: '' })
    const message = (size: number) => ({
      ...envelope,
      payload: 'x'.repeat(size),
    })
    // Length of the published message: base64 data and attributes.
    const json = JSON.stringify(message(0)).length
    const attributes = JSON.stringify({
      data: '',
      attributes: { event: envelope.event, listener: envelope.listener },
    }).length
    const published = (size: number) =>
      attributes + 4 * Math.ceil((json + size) / 3)
    // The largest message that fits: {"messages":[...]} stays under 10 MB.
    let size = 7_499_000
    while (published(size + 1) <= 10_000_000 - 21) size += 1
    await transport.send([message(size)], { delay: undefined })
    expect(lengths).toEqual([published(size) + 15])
    expect(lengths[0]).toBeLessThanOrEqual(10_000_000)
    await expect(
      transport.send([message(size + 1)], { delay: undefined })
    ).rejects.toMatchObject({ name: 'PartialSendError' })
    expect(lengths).toHaveLength(1)
  })

  it('keeps batches under the limit of a request', LARGE_TIMEOUT, async () => {
    const lengths: number[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      lengths.push(String(init?.body).length)
      return Response.json({ messageIds: [] })
    })
    const transport = createPubSubTransport({
      topic: TOPIC,
      getAccessToken: false,
      fetch,
    })
    const envelope = envelopeOf({ payload: '' })
    const message = (id: string, size: number) => ({
      ...envelope,
      id,
      payload: 'x'.repeat(size),
    })
    const json = JSON.stringify(message('a', 0)).length
    const attributes = JSON.stringify({
      data: '',
      attributes: { event: envelope.event, listener: envelope.listener },
    }).length
    const published = (size: number) =>
      attributes + 4 * Math.ceil((json + size) / 3)
    // {"messages":[a,b]} takes their lengths + 16 bytes; the transport
    // keeps a margin of 6 bytes.
    let size = 3_700_000
    while (2 * published(size + 1) + 22 <= 10_000_000) size += 1
    await transport.send([message('a', size), message('b', size)], {
      delay: undefined,
    })
    expect(lengths).toEqual([2 * published(size) + 16])
    // Over the limit with the JSON overhead: two requests.
    const over = size + 3
    expect(2 * published(over) + 22).toBeGreaterThan(10_000_000)
    expect(2 * published(over) + 2).toBeLessThanOrEqual(10_000_000)
    await transport.send([message('a', over), message('b', over)], {
      delay: undefined,
    })
    expect(lengths.slice(1)).toEqual([
      published(over) + 15,
      published(over) + 15,
    ])
  })

  it('reports the messages of a failed request, and keeps the others', async () => {
    const transport = createPubSubTransport({
      topic: TOPIC,
      getAccessToken: false,
      baseUrl: server.url,
    })
    server.failNext(
      TOPIC,
      403,
      JSON.stringify({
        error: {
          code: 403,
          message: 'User not authorized to perform this action.',
          status: 'PERMISSION_DENIED',
        },
      })
    )
    const error = await transport
      .send([envelopeOf({ id: 'a' }), envelopeOf({ id: 'b' })], {
        delay: undefined,
      })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      name: 'PartialSendError',
      failed: [
        { id: 'a', error: expect.any(Error) },
        { id: 'b', error: expect.any(Error) },
      ],
    })
    const { failed } = error as { failed: { error: Error }[] }
    expect(failed[0]?.error.message).toBe(
      'Pub/Sub API: 403 PERMISSION_DENIED: User not authorized to perform this action.'
    )
  })

  it('describes errors without a Google body', async () => {
    const respond = (body: string, status: number, statusText = '') =>
      createPubSubTransport({
        topic: TOPIC,
        getAccessToken: false,
        fetch: async () => new Response(body, { status, statusText }),
      }).send([envelopeOf()], { delay: undefined })
    const messageOf = (sending: Promise<void>) =>
      sending.catch(
        (error: { failed: { error: Error }[] }) =>
          error.failed[0]?.error.message
      )
    expect(await messageOf(respond('<html>', 502, 'Bad Gateway'))).toBe(
      'Pub/Sub API: 502 Bad Gateway'
    )
    expect(await messageOf(respond('{}', 500))).toBe('Pub/Sub API: 500')
    expect(
      await messageOf(respond('{"error":{"message":"Quota exceeded"}}', 429))
    ).toBe('Pub/Sub API: 429 Quota exceeded')
  })

  it('fails the emission when the token cannot be obtained', async () => {
    const events = createEventBus({
      transport: createPubSubTransport({
        topic: TOPIC,
        getAccessToken: async () => {
          throw new Error('metadata server unreachable')
        },
        baseUrl: server.url,
      }),
      listeners: [listenerOf('a', () => {})],
    })
    const error = await events
      .emit(userCreated, { userId: '42' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EventEmitError)
    expect((error as EventEmitError).failed).toEqual([
      expect.objectContaining({
        error: new Error('metadata server unreachable'),
      }),
    ])
  })

  it('gets the token from Application Default Credentials', async () => {
    const getAccessToken = vi.fn(async () => 'adc-token')
    const GoogleAuth = vi.fn(function (this: object) {
      Object.assign(this, { getAccessToken })
    })
    vi.doMock('google-auth-library', () => ({ GoogleAuth }))
    const { createPubSubTransport: create } =
      await import('../src/transports/google-pubsub.js')
    const transport = create({ topic: TOPIC, baseUrl: server.url })
    await transport.send([envelopeOf()], { delay: undefined })
    await transport.send([envelopeOf()], { delay: undefined })
    expect(server.calls.at(-1)?.auth).toBe('Bearer adc-token')
    expect(GoogleAuth).toHaveBeenCalledExactlyOnceWith({
      scopes: 'https://www.googleapis.com/auth/pubsub',
    })
    expect(getAccessToken).toHaveBeenCalledTimes(2)

    getAccessToken.mockResolvedValueOnce(null as never)
    await expect(
      transport.send([envelopeOf()], { delay: undefined })
    ).rejects.toMatchObject({
      failed: [
        {
          error: new Error('No Google access token: check the credentials.'),
        },
      ],
    })
  })

  it('asks for google-auth-library when it is missing, and tries again', async () => {
    let installed = false
    vi.doMock('google-auth-library', () => {
      if (!installed) throw new Error('Cannot find package')
      return {
        GoogleAuth: function (this: object) {
          Object.assign(this, { getAccessToken: async () => 'later' })
        },
      }
    })
    const { createPubSubTransport: create } =
      await import('../src/transports/google-pubsub.js')
    const transport = create({ topic: TOPIC, baseUrl: server.url })
    const error = await transport
      .send([envelopeOf()], { delay: undefined })
      .catch(
        (caught: { failed: { error: Error }[] }) => caught.failed[0]?.error
      )
    expect(error?.message).toBe(
      'Install google-auth-library, or pass getAccessToken, to publish to Pub/Sub.'
    )
    expect(error?.cause).toBeInstanceOf(Error)
    installed = true
    vi.resetModules()
    await transport.send([envelopeOf()], { delay: undefined })
    expect(server.calls.at(-1)?.auth).toBe('Bearer later')
  })

  it('checks its options', () => {
    const create = (options: object) => () =>
      createPubSubTransport(options as never)
    expect(create(null as never)).toThrow(
      'createPubSubTransport(): expected an object of options.'
    )
    expect(create(Object.assign([], { topic: TOPIC }))).toThrow(
      'createPubSubTransport(): expected an object of options.'
    )
    expect(create({ topic: { toString: () => TOPIC } })).toThrow(
      'createPubSubTransport(): topic must be a full name'
    )
    expect(create({ topic: TOPIC, region: 'eu' })).toThrow(
      'createPubSubTransport(): unknown option "region".'
    )
    for (const topic of [
      undefined,
      'events',
      'projects/p/topics/',
      'projects//topics/t',
      'projects/p/subscriptions/s',
      'projects/p/topics/t/extra',
      'xprojects/p/topics/t',
    ]) {
      expect(create({ topic })).toThrow(
        'createPubSubTransport(): topic must be a full name, like projects/my-project/topics/events.'
      )
    }
    expect(create({ topic: TOPIC, getAccessToken: 'token' })).toThrow(
      'createPubSubTransport(): getAccessToken must be a function, or false.'
    )
    expect(create({ topic: TOPIC, getAccessToken: true })).toThrow(
      'getAccessToken must be a function, or false.'
    )
    for (const baseUrl of [
      'pubsub.googleapis.com',
      'http:///x',
      'ftp://x',
      42,
    ]) {
      expect(create({ topic: TOPIC, baseUrl })).toThrow(
        'createPubSubTransport(): baseUrl must be an http(s) URL.'
      )
    }
    expect(create({ topic: TOPIC, fetch: 'fetch' })).toThrow(
      'createPubSubTransport(): fetch must be a function.'
    )
    expect(
      create({ topic: TOPIC, baseUrl: 'http://localhost:8085' })
    ).not.toThrow()
  })
})

/** Push body of a message, as Pub/Sub sends it. */
const pushBody = (data: unknown, extra: object = {}) => ({
  message: {
    data: typeof data === 'string' ? data : base64(data),
    attributes: { event: 'user.created' },
    messageId: '1',
    publishTime: '2026-11-10T10:00:00.000Z',
  },
  subscription: 'projects/test-project/subscriptions/events-push',
  ...extra,
})

describe('Pub/Sub push handler', () => {
  const claims = { aud: AUDIENCE, email: ACCOUNT, email_verified: true }
  const handlerOf = (
    handle: ListenerHandler<{ userId: string }> = () => {},
    options: object = {}
  ) =>
    createPubSubPushHandler(
      createWorker({
        listeners: [listenerOf('send-welcome-mail', handle)],
        maxAttempts: 5,
      }),
      {
        audience: AUDIENCE,
        serviceAccountEmail: ACCOUNT,
        certsUrl: server.certsUrl,
        ...options,
      }
    )

  it('runs the listener of a verified push request', async () => {
    const handle = vi.fn()
    const push = handlerOf(handle)
    const response = await push.fetch(
      new Request('https://api.example.com/pubsub', {
        method: 'POST',
        headers: { authorization: `Bearer ${await server.token(claims)}` },
        body: JSON.stringify(pushBody(envelopeOf())),
      })
    )
    expect(response.status).toBe(204)
    expect(handle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        payload: { userId: '42' },
        attempt: 1,
        id: envelopeOf().id,
      })
    )
  })

  it('accepts the issuer without scheme, and any account without serviceAccountEmail', async () => {
    const push = handlerOf(undefined, { serviceAccountEmail: undefined })
    const token = await server.token(
      { ...claims, email: 'other@test-project.iam.gserviceaccount.com' },
      { issuer: 'accounts.google.com' }
    )
    expect(await push.handle(pushBody(envelopeOf()), `Bearer ${token}`)).toBe(
      204
    )
  })

  it('refuses requests without a valid token', async () => {
    const handle = vi.fn()
    const logger = createLogger()
    const push = handlerOf(handle, { logger })
    const body = pushBody(envelopeOf())
    const sign = (overrides: object, options?: { issuer: string }) =>
      server.token({ ...claims, ...overrides }, options)

    expect(await push.handle(body, undefined)).toBe(401)
    expect(logger.entries).toEqual([])
    expect(await push.handle(body, 'Basic abc')).toBe(401)
    expect(await push.handle(body, `Token Bearer ${await sign({})}`)).toBe(401)
    expect(await push.handle(body, `Bearer ${await sign({})}`)).toBe(204)
    expect(await push.handle(body, 'Bearer ')).toBe(401)
    expect(await push.handle(body, 'Bearer not-a-token')).toBe(401)
    expect(
      await push.handle(body, `Bearer ${await sign({ aud: 'https://other' })}`)
    ).toBe(401)
    expect(
      await push.handle(
        body,
        `Bearer ${await sign({}, { issuer: 'https://evil.example.com' })}`
      )
    ).toBe(401)
    expect(
      await push.handle(
        body,
        `Bearer ${await sign({ email: 'x@example.com' })}`
      )
    ).toBe(403)
    expect(
      await push.handle(body, `Bearer ${await sign({ email_verified: false })}`)
    ).toBe(403)
    expect(
      await push.handle(
        body,
        `Bearer ${await sign({ email_verified: 'true' })}`
      )
    ).toBe(403)
    expect(handle).toHaveBeenCalledOnce()
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'Invalid Pub/Sub push token',
      data: { error: expect.any(String) },
    })
  })

  it('skips the verification with verifyToken: false', async () => {
    const push = createPubSubPushHandler(
      createWorker({ listeners: [listenerOf('send-welcome-mail', () => {})] }),
      { verifyToken: false }
    )
    expect(await push.handle(pushBody(envelopeOf()), undefined)).toBe(204)
  })

  it('asks Pub/Sub to deliver failed messages again', async () => {
    const onFailure = vi.fn()
    const push = createPubSubPushHandler(
      createWorker({
        listeners: [
          listenerOf('send-welcome-mail', () => {
            throw new Error('SMTP down')
          }),
        ],
        maxAttempts: 5,
        onFailure,
      }),
      { verifyToken: false }
    )
    expect(
      await push.handle(
        pushBody(envelopeOf(), { deliveryAttempt: 5 }),
        undefined
      )
    ).toBe(503)
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      new Error('SMTP down'),
      expect.objectContaining({ attempt: 5, final: true })
    )
    expect(
      await push.handle(
        pushBody(envelopeOf(), { deliveryAttempt: '2' }),
        undefined
      )
    ).toBe(503)
    expect(onFailure).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ attempt: 1, final: false })
    )
  })

  it('answers 400 to bodies that are not push messages', async () => {
    const push = handlerOf(undefined, { verifyToken: false })
    expect(await push.handle(undefined, undefined)).toBe(400)
    expect(await push.handle({ message: 'x' }, undefined)).toBe(400)
    expect(await push.handle([pushBody(envelopeOf())], undefined)).toBe(400)
    const response = await push.fetch(
      new Request('https://api.example.com/pubsub', {
        method: 'POST',
        body: '{not json',
      })
    )
    expect(response.status).toBe(400)
  })

  it('fails messages that are not envelopes without dead-letter topic', async () => {
    const onFailure = vi.fn()
    const push = createPubSubPushHandler(
      createWorker({ listeners: [], onFailure }),
      { verifyToken: false }
    )
    expect(
      await push.handle({ message: { attributes: { a: 'b' } } }, undefined)
    ).toBe(503)
    expect(await push.handle(pushBody('%%%'), undefined)).toBe(503)
    expect(await push.handle(pushBody(envelopeOf()), undefined)).toBe(503)
    expect(onFailure.mock.calls.map(([, info]) => info.reason)).toEqual([
      'invalid-envelope',
      'invalid-envelope',
      'unknown-listener',
    ])
  })

  it('publishes dead messages to the dead-letter topic', async () => {
    const getAccessToken = vi.fn(async () => 'dlq-token')
    const push = createPubSubPushHandler(createWorker({ listeners: [] }), {
      verifyToken: false,
      deadLetter: { topic: DLQ, getAccessToken, baseUrl: server.url },
    })
    const data = base64(envelopeOf({ listener: 'removed' }))
    expect(await push.handle(pushBody(data), undefined)).toBe(204)
    expect(server.published(DLQ).at(-1)).toEqual({
      data,
      attributes: {
        reason: 'unknown-listener',
        error: 'Unknown listener "removed": this worker runs no listener.',
      },
    })
    expect(server.calls.at(-1)?.auth).toBe('Bearer dlq-token')
    expect(
      await push.handle({ message: { attributes: { a: 'b' } } }, undefined)
    ).toBe(204)
    expect(server.published(DLQ).at(-1)).toEqual({
      data: '',
      attributes: { reason: 'invalid-envelope', error: expect.any(String) },
    })
    expect(await push.handle({ message: { data: 42 } }, undefined)).toBe(204)
    expect(server.published(DLQ).at(-1)?.data).toBe('')
  })

  it('truncates the error of dead messages to 1,024 characters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ messageIds: ['1'] })
    )
    const push = createPubSubPushHandler(createWorker({ listeners: [] }), {
      verifyToken: false,
      deadLetter: { topic: DLQ, getAccessToken: false },
      fetch,
    })
    const listener = 'l'.repeat(128)
    await push.handle(pushBody(envelopeOf({ listener })), undefined)
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      messages: { attributes: { error: string } }[]
    }
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://pubsub.googleapis.com/v1/${DLQ}:publish`
    )
    expect(body.messages[0]?.attributes.error).toBe(
      `Unknown listener "${listener}": this worker runs no listener.`
    )

    const long = createPubSubPushHandler(
      createWorker({ listeners: [listenerOf('send-welcome-mail', () => {})] }),
      {
        verifyToken: false,
        deadLetter: { topic: DLQ, getAccessToken: false },
        fetch,
      }
    )
    await long.handle(
      pushBody(envelopeOf({ payload: { userId: 42 } })),
      undefined
    )
    const error = (
      JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)) as {
        messages: { attributes: { reason: string; error: string } }[]
      }
    ).messages[0]?.attributes
    expect(error?.reason).toBe('invalid-payload')
    expect(error?.error.length).toBeLessThanOrEqual(1024)
  })

  it('cuts errors longer than 1,024 characters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ messageIds: ['1'] })
    )
    const worker = {
      listeners: [],
      handle: async () => ({
        status: 'dead' as const,
        reason: 'invalid-payload' as const,
        error: new Error('e'.repeat(2000)),
      }),
    }
    const push = createPubSubPushHandler(worker, {
      verifyToken: false,
      deadLetter: { topic: DLQ, getAccessToken: false },
      fetch,
    })
    expect(await push.handle(pushBody(envelopeOf()), undefined)).toBe(204)
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      messages: { attributes: { error: string } }[]
    }
    expect(body.messages[0]?.attributes.error).toBe('e'.repeat(1024))
  })

  it('keeps retrying when the dead-letter topic fails', async () => {
    const logger = createLogger()
    const push = createPubSubPushHandler(createWorker({ listeners: [] }), {
      verifyToken: false,
      deadLetter: { topic: DLQ, getAccessToken: false, baseUrl: server.url },
      logger,
    })
    server.failNext(DLQ, 500, '{}')
    expect(await push.handle(pushBody(envelopeOf()), undefined)).toBe(503)
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Cannot publish the message to the dead-letter topic',
      data: { error: 'Pub/Sub API: 500 Internal Server Error' },
    })
  })

  it('does not publish retried messages to the dead-letter topic', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const push = createPubSubPushHandler(
      createWorker({
        listeners: [
          listenerOf('send-welcome-mail', () => {
            throw new Error('down')
          }),
        ],
      }),
      {
        verifyToken: false,
        deadLetter: { topic: DLQ, getAccessToken: false },
        fetch,
      }
    )
    expect(await push.handle(pushBody(envelopeOf()), undefined)).toBe(503)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('verifies tokens with the Google keys by default', async () => {
    const jwks = Symbol('jwks')
    const createRemoteJWKSet = vi.fn(() => jwks)
    const jwtVerify = vi.fn(async () => ({
      payload: { email: ACCOUNT, email_verified: true },
    }))
    vi.doMock('jose', () => ({ createRemoteJWKSet, jwtVerify }))
    const { createPubSubPushHandler: create } =
      await import('../src/transports/google-pubsub.js')
    const push = create(
      createWorker({ listeners: [listenerOf('send-welcome-mail', () => {})] }),
      { audience: AUDIENCE }
    )
    expect(await push.handle(pushBody(envelopeOf()), 'Bearer abc')).toBe(204)
    expect(await push.handle(pushBody(envelopeOf()), 'Bearer def')).toBe(204)
    expect(createRemoteJWKSet).toHaveBeenCalledExactlyOnceWith(
      new URL('https://www.googleapis.com/oauth2/v3/certs')
    )
    expect(jwtVerify).toHaveBeenCalledWith('abc', jwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: AUDIENCE,
    })
  })

  it('asks for jose when it is missing, and tries again', async () => {
    let installed = false
    const actual = await vi.importActual<typeof import('jose')>('jose')
    vi.doMock('jose', () => {
      if (!installed) throw new Error('Cannot find package')
      return actual
    })
    const { createPubSubPushHandler: create } =
      await import('../src/transports/google-pubsub.js')
    const logger = createLogger()
    const push = create(
      createWorker({ listeners: [listenerOf('send-welcome-mail', () => {})] }),
      { audience: AUDIENCE, certsUrl: server.certsUrl, logger }
    )
    const authorization = `Bearer ${await server.token(claims)}`
    expect(await push.handle(pushBody(envelopeOf()), authorization)).toBe(401)
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message: 'Invalid Pub/Sub push token',
      data: { error: 'Install jose to verify Pub/Sub push tokens.' },
    })
    installed = true
    vi.resetModules()
    expect(await push.handle(pushBody(envelopeOf()), authorization)).toBe(204)
  })

  it('checks its options', () => {
    const worker = createWorker({ listeners: [] })
    const create =
      (options: object, target: unknown = worker) =>
      () =>
        createPubSubPushHandler(target as never, options as never)
    const label = 'createPubSubPushHandler()'
    expect(create({}, {})).toThrow(
      `${label}: expected a worker created by createWorker().`
    )
    expect(create({}, null)).toThrow('expected a worker')
    expect(create(null as never)).toThrow(
      `${label}: expected an object of options.`
    )
    expect(() => createPubSubPushHandler(worker)).toThrow(
      `${label}: audience is required to verify push tokens (or set verifyToken: false behind a proxy that checks them).`
    )
    expect(create({ audience: '' })).toThrow('audience is required')
    expect(create({ audience: AUDIENCE, topic: TOPIC })).toThrow(
      `${label}: unknown option "topic".`
    )
    expect(create({ verifyToken: 'no' })).toThrow(
      `${label}: verifyToken must be a boolean.`
    )
    for (const serviceAccountEmail of ['', 42]) {
      expect(create({ audience: AUDIENCE, serviceAccountEmail })).toThrow(
        `${label}: serviceAccountEmail must be a non-empty string.`
      )
    }
    for (const certsUrl of ['www.googleapis.com/certs', 'http:///certs', 1]) {
      expect(create({ audience: AUDIENCE, certsUrl })).toThrow(
        `${label}: certsUrl must be an http(s) URL.`
      )
    }
    expect(create({ verifyToken: false, deadLetter: 'topic' })).toThrow(
      `${label}: deadLetter: expected an object of options.`
    )
    expect(
      create({ verifyToken: false, deadLetter: { topic: DLQ, fetch } })
    ).toThrow(`${label}: deadLetter: unknown option "fetch".`)
    expect(
      create({ verifyToken: false, deadLetter: { topic: 'dlq' } })
    ).toThrow(
      `${label}: topic must be a full name, like projects/my-project/topics/events.`
    )
    expect(
      create({ verifyToken: false, deadLetter: { topic: DLQ }, fetch: 1 })
    ).toThrow(`${label}: fetch must be a function.`)
    expect(create({ verifyToken: false, audience: undefined })).not.toThrow()
  })
})

/** A Pub/Sub client recording its calls. */
const fakeClient = () => {
  const subscription = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => {}),
  })
  const publishMessage = vi.fn<(message: object) => Promise<string>>(
    async () => 'dlq-1'
  )
  const client = {
    subscription: vi.fn<(name: string, options: object) => typeof subscription>(
      () => subscription
    ),
    topic: vi.fn<(name: string) => { publishMessage: typeof publishMessage }>(
      () => ({ publishMessage })
    ),
    close: vi.fn(async () => {}),
  }
  return { client, subscription, publishMessage }
}

const pulledMessage = (data: unknown, deliveryAttempt = 0) => ({
  data: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)),
  deliveryAttempt,
  ack: vi.fn(),
  nack: vi.fn(),
})

const settled = (message: ReturnType<typeof pulledMessage>) =>
  vi.waitFor(() =>
    expect(message.ack.mock.calls.length + message.nack.mock.calls.length).toBe(
      1
    )
  )

describe('Pub/Sub pull source', () => {
  const SUBSCRIPTION = 'projects/test-project/subscriptions/events'

  it('acks handled messages and nacks failed ones', async () => {
    const { client, subscription } = fakeClient()
    const onFailure = vi.fn()
    const worker = createWorker({
      listeners: [
        listenerOf('send-welcome-mail', ({ payload: { userId } }) => {
          if (userId === 'fail') throw new Error('down')
        }),
      ],
      onFailure,
      maxAttempts: 5,
    })
    const running = startWorker(
      worker,
      createPubSubPullSource({
        subscription: SUBSCRIPTION,
        client: client as never,
        maxMessages: 4,
      })
    )
    await vi.waitFor(() => expect(client.subscription).toHaveBeenCalled())
    expect(client.subscription).toHaveBeenCalledExactlyOnceWith(SUBSCRIPTION, {
      flowControl: { maxMessages: 4, allowExcessMessages: false },
    })
    expect(client.topic).not.toHaveBeenCalled()

    const ok = pulledMessage(envelopeOf())
    const failed = pulledMessage(envelopeOf({ payload: { userId: 'fail' } }), 5)
    const dead = pulledMessage('not json')
    for (const message of [ok, failed, dead])
      subscription.emit('message', message)
    await Promise.all([ok, failed, dead].map(settled))
    expect(ok.ack).toHaveBeenCalledOnce()
    expect(failed.nack).toHaveBeenCalledOnce()
    expect(dead.nack).toHaveBeenCalledOnce()
    expect(
      onFailure.mock.calls
        .map(([, info]) => [info.reason, info.attempt, info.final])
        .sort()
    ).toEqual([
      ['invalid-envelope', 1, true],
      ['listener-error', 5, true],
    ])

    await running.stop()
    expect(subscription.close).toHaveBeenCalledOnce()
    expect(client.close).not.toHaveBeenCalled()
  })

  it('publishes dead messages to the dead-letter topic, then acks them', async () => {
    const { client, subscription, publishMessage } = fakeClient()
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners: [] }),
      createPubSubPullSource({
        subscription: SUBSCRIPTION,
        client: client as never,
        deadLetterTopic: DLQ,
      }),
      { logger }
    )
    await vi.waitFor(() => expect(client.subscription).toHaveBeenCalled())
    expect(client.subscription.mock.calls[0]?.[1]).toEqual({
      flowControl: { maxMessages: 10, allowExcessMessages: false },
    })
    expect(client.topic).toHaveBeenCalledExactlyOnceWith(DLQ)

    const dead = pulledMessage(envelopeOf({ listener: 'removed' }))
    subscription.emit('message', dead)
    await settled(dead)
    expect(dead.ack).toHaveBeenCalledOnce()
    expect(publishMessage).toHaveBeenCalledExactlyOnceWith({
      data: dead.data,
      attributes: {
        reason: 'unknown-listener',
        error: 'Unknown listener "removed": this worker runs no listener.',
      },
    })

    publishMessage.mockRejectedValueOnce(new Error('topic not found'))
    const stuck = pulledMessage(envelopeOf({ listener: 'removed' }))
    subscription.emit('message', stuck)
    await settled(stuck)
    expect(stuck.nack).toHaveBeenCalledOnce()
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Cannot publish the message to the dead-letter topic',
      data: { error: 'topic not found' },
    })
    await running.stop()
  })

  it('truncates the error of dead messages', async () => {
    const { client, subscription, publishMessage } = fakeClient()
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
      createPubSubPullSource({
        subscription: SUBSCRIPTION,
        client: client as never,
        deadLetterTopic: DLQ,
      })
    )
    await vi.waitFor(() => expect(client.subscription).toHaveBeenCalled())
    const dead = pulledMessage(envelopeOf())
    subscription.emit('message', dead)
    await settled(dead)
    expect(publishMessage.mock.calls[0]?.[0]).toEqual({
      data: dead.data,
      attributes: { reason: 'invalid-payload', error: 'e'.repeat(1024) },
    })
    await running.stop()
  })

  it('does not publish retried messages to the dead-letter topic', async () => {
    const { client, subscription, publishMessage } = fakeClient()
    const running = startWorker(
      createWorker({
        listeners: [
          listenerOf('send-welcome-mail', () => {
            throw new Error('down')
          }),
        ],
      }),
      createPubSubPullSource({
        subscription: SUBSCRIPTION,
        client: client as never,
        deadLetterTopic: DLQ,
      })
    )
    await vi.waitFor(() => expect(client.subscription).toHaveBeenCalled())
    const failed = pulledMessage(envelopeOf())
    subscription.emit('message', failed)
    await settled(failed)
    expect(failed.nack).toHaveBeenCalledOnce()
    expect(publishMessage).not.toHaveBeenCalled()
    await running.stop()
  })

  it('logs subscription errors', async () => {
    const { client, subscription } = fakeClient()
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners: [] }),
      createPubSubPullSource({
        subscription: SUBSCRIPTION,
        client: client as never,
      }),
      { logger }
    )
    await vi.waitFor(() => expect(client.subscription).toHaveBeenCalled())
    subscription.emit('error', new Error('PERMISSION_DENIED'))
    await running.stop()
    expect(logger.entries).toContainEqual({
      level: 'error',
      message: 'Pub/Sub subscription error',
      data: { subscription: SUBSCRIPTION, error: 'PERMISSION_DENIED' },
    })
  })

  it('waits for the subscription to close by default', async () => {
    const { client, subscription } = fakeClient()
    subscription.close.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    )
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners: [] }),
      createPubSubPullSource({
        subscription: SUBSCRIPTION,
        client: client as never,
      }),
      { logger }
    )
    await vi.waitFor(() => expect(client.subscription).toHaveBeenCalled())
    await running.stop()
    expect(logger.entries.filter(({ level }) => level === 'warn')).toEqual([])
  })

  it('stops without waiting after closeTimeout', async () => {
    const { client, subscription } = fakeClient()
    subscription.close.mockImplementation(() => new Promise(() => {}))
    const logger = createLogger()
    const running = startWorker(
      createWorker({ listeners: [] }),
      createPubSubPullSource({
        subscription: SUBSCRIPTION,
        client: client as never,
        closeTimeout: 50,
      }),
      { logger }
    )
    await vi.waitFor(() => expect(client.subscription).toHaveBeenCalled())
    await running.stop()
    expect(logger.entries).toContainEqual({
      level: 'warn',
      message:
        'Pub/Sub subscription not closed in time: stopped without waiting',
      data: { subscription: SUBSCRIPTION, closeTimeout: 50 },
    })
  })

  it('stops at once when already aborted', async () => {
    const { client, subscription } = fakeClient()
    const source = createPubSubPullSource({
      subscription: SUBSCRIPTION,
      client: client as never,
    })
    await source.consume(createWorker({ listeners: [] }), {
      signal: AbortSignal.abort(),
      logger: createLogger(),
    })
    expect(subscription.close).toHaveBeenCalledOnce()
  })

  it('creates its own client with clientConfig, and closes it', async () => {
    const { client, subscription } = fakeClient()
    const PubSub = vi.fn(function (this: object, config: object) {
      Object.assign(this, client, { config })
    })
    vi.doMock('@google-cloud/pubsub', () => ({ PubSub }))
    const { createPubSubPullSource: create } =
      await import('../src/transports/google-pubsub.js')
    const running = startWorker(
      createWorker({ listeners: [] }),
      create({ subscription: SUBSCRIPTION, clientConfig: { projectId: 'p' } })
    )
    await vi.waitFor(() => expect(client.subscription).toHaveBeenCalled())
    expect(PubSub).toHaveBeenCalledExactlyOnceWith({ projectId: 'p' })
    await running.stop()
    expect(subscription.close).toHaveBeenCalledOnce()
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('checks its options', () => {
    const label = 'createPubSubPullSource()'
    const create = (options: object) => () =>
      createPubSubPullSource({ subscription: SUBSCRIPTION, ...options })
    expect(() => createPubSubPullSource(null as never)).toThrow(
      `${label}: expected an object of options.`
    )
    expect(create({ topic: TOPIC })).toThrow(
      `${label}: unknown option "topic".`
    )
    for (const subscription of [
      'events',
      TOPIC,
      'projects/p/subscriptions/',
      'projects/p/subscriptions/s/extra',
    ]) {
      expect(create({ subscription })).toThrow(
        `${label}: subscription must be a full name, like projects/my-project/subscriptions/events.`
      )
    }
    expect(
      create({ client: fakeClient().client, clientConfig: { projectId: 'p' } })
    ).toThrow(`${label}: set client or clientConfig, not both.`)
    for (const client of [null, {}, 'pubsub']) {
      expect(create({ client })).toThrow(
        `${label}: client must be a PubSub client.`
      )
    }
    for (const maxMessages of [0, 1.5, '10']) {
      expect(create({ maxMessages })).toThrow(
        `${label}: maxMessages must be a positive integer.`
      )
    }
    expect(create({ deadLetterTopic: 'dlq' })).toThrow(
      `${label}: deadLetterTopic must be a full name, like projects/my-project/topics/events-dlq.`
    )
    for (const closeTimeout of [-1, 0.5, '1000']) {
      expect(create({ closeTimeout })).toThrow(
        `${label}: closeTimeout must be a non-negative integer (milliseconds).`
      )
    }
    expect(
      create({ maxMessages: 1, closeTimeout: 0, deadLetterTopic: DLQ })
    ).not.toThrow()
  })
})

// Against the Pub/Sub emulator: PUBSUB_EMULATOR_HOST=localhost:8085.
const emulator = process.env.PUBSUB_EMULATOR_HOST

describe.skipIf(!emulator)('Pub/Sub (emulator)', () => {
  const project = 'test-project'
  const suffix = Date.now().toString(36)
  const topic = `projects/${project}/topics/events-${suffix}`
  const deadTopic = `projects/${project}/topics/events-dlq-${suffix}`
  const pull = `projects/${project}/subscriptions/events-${suffix}`
  const deadPull = `projects/${project}/subscriptions/events-dlq-${suffix}`
  const pushSubscription = `projects/${project}/subscriptions/events-push-${suffix}`
  let pubsub: PubSub
  let push: Server | undefined

  beforeAll(async () => {
    pubsub = new PubSub({ projectId: project })
    await pubsub.createTopic(topic)
    await pubsub.createTopic(deadTopic)
    await pubsub
      .topic(topic)
      .createSubscription(pull, { ackDeadlineSeconds: 10 })
    await pubsub.topic(deadTopic).createSubscription(deadPull)
  })
  afterAll(async () => {
    await new Promise<void>((resolve) =>
      push ? push.close(() => resolve()) : resolve()
    )
    await pubsub.close()
  })

  const transport = () =>
    createPubSubTransport({
      topic,
      getAccessToken: false,
      baseUrl: `http://${emulator}`,
    })

  it('publishes with the transport, and pulls with the source', async () => {
    const received: string[] = []
    const listeners = ['a', 'b'].map((name) =>
      listenerOf(name, ({ payload: { userId } }) => {
        received.push(`${name}:${userId}`)
      })
    )
    const events = createEventBus({ transport: transport(), listeners })
    await events.emit(userCreated, { userId: '42' })
    const running = startWorker(
      createWorker({ listeners }),
      createPubSubPullSource({
        subscription: pull,
        clientConfig: { projectId: project },
      })
    )
    await vi.waitFor(() => expect(received.sort()).toEqual(['a:42', 'b:42']), {
      timeout: 10_000,
    })
    await running.stop()
  })

  it('redelivers failed messages, and publishes dead ones to the dead-letter topic', async () => {
    let attempts = 0
    const listener = listenerOf('flaky', () => {
      attempts += 1
      if (attempts < 2) throw new Error('down')
    })
    const events = createEventBus({
      transport: transport(),
      listeners: [listener],
    })
    await events.emit(userCreated, { userId: '42' })
    await transport().send([envelopeOf({ listener: 'removed' })], {
      delay: undefined,
    })
    const running = startWorker(
      createWorker({ listeners: [listener] }),
      createPubSubPullSource({
        subscription: pull,
        client: pubsub,
        deadLetterTopic: deadTopic,
      })
    )
    await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 15_000 })
    const dead = await new Promise<{ data: string; attributes: object }>(
      (resolve) => {
        const subscription = pubsub.subscription(deadPull)
        subscription.once('message', (message) => {
          message.ack()
          void subscription.close()
          resolve({
            data: message.data.toString('utf8'),
            attributes: message.attributes,
          })
        })
      }
    )
    expect(JSON.parse(dead.data)).toEqual(envelopeOf({ listener: 'removed' }))
    expect(dead.attributes).toEqual({
      reason: 'unknown-listener',
      error: 'Unknown listener "removed": this worker runs flaky.',
    })
    await running.stop()
  })

  it('handles push deliveries', async () => {
    const handle = vi.fn()
    const handler = createPubSubPushHandler(
      createWorker({ listeners: [listenerOf('pushed', handle)] }),
      { verifyToken: false }
    )
    push = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        void handler
          .handle(JSON.parse(Buffer.concat(chunks).toString('utf8')), undefined)
          .then((status) => {
            res.writeHead(status)
            res.end()
          })
      })
    })
    await new Promise<void>((resolve) => push?.listen(0, '0.0.0.0', resolve))
    const port = (push.address() as AddressInfo).port
    const host = process.env.PUBSUB_PUSH_HOST ?? 'host.docker.internal'
    await pubsub.topic(topic).createSubscription(pushSubscription, {
      pushConfig: { pushEndpoint: `http://${host}:${port}/` },
    })
    await transport().send([envelopeOf({ listener: 'pushed' })], {
      delay: undefined,
    })
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce(), {
      timeout: 15_000,
    })
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      payload: { userId: '42' },
    })
  })
})
