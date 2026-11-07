import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { sse, stream, type DotpressRequest } from '../src/index.js'
import { createTestApp, silentLogger } from './support/memory-adapter.js'

const decoder = new TextDecoder()

const readChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const { done, value } = await reader.read()
  return done ? undefined : decoder.decode(value)
}

const bodyStream = (body: unknown) => {
  if (!(body instanceof ReadableStream)) {
    throw new Error('Expected a streamed body')
  }
  return body as ReadableStream<Uint8Array>
}

const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

describe('streaming', () => {
  describe('stream()', () => {
    it('accepts iterables of strings and bytes', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/array',
          handler: () => stream(['a', new TextEncoder().encode('b'), 'c']),
        })
      })

      const res = await inject({ url: '/array' })

      expect(res.status).toBe(200)
      expect(res.kind).toBe('stream')
      expect(res.headers['content-type']).toBe('application/octet-stream')
      expect(res.text).toBe('abc')
    })

    it('accepts async generator functions', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/export.csv',
          handler: () =>
            stream(
              async function* () {
                yield 'id,name\n'
                for (const [id, name] of [
                  [1, 'Ada'],
                  [2, 'Linus'],
                ]) {
                  await Promise.resolve()
                  yield `${id},${name}\n`
                }
              },
              { contentType: 'text/csv; charset=utf-8', status: 201 }
            ),
        })
      })

      const res = await inject({ url: '/export.csv' })

      expect(res.status).toBe(201)
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
      expect(res.text).toBe('id,name\n1,Ada\n2,Linus\n')
    })

    it('treats a string as a single chunk', async () => {
      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({ path: '/single', handler: () => stream('hello') })
      })

      const reader = bodyStream(
        (await dispatch({ url: '/single' })).body
      ).getReader()

      expect(await readChunk(reader)).toBe('hello')
      expect(await readChunk(reader)).toBeUndefined()
    })

    it('keeps the headers set on ctx.res', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/report',
          handler: ({ res }) => {
            res.setHeader('x-report', 'monthly')
            res.setCookie('seen', '1')
            return stream(['data'], { headers: { 'x-extra': 'yes' } })
          },
        })
      })

      const res = await inject({ url: '/report' })

      expect(res.headers).toMatchObject({
        'x-report': 'monthly',
        'x-extra': 'yes',
        'set-cookie': ['seen=1; Path=/'],
      })
    })

    it('pulls the source on demand', async () => {
      const pulled: number[] = []
      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({
          path: '/lazy',
          handler: () =>
            stream(function* () {
              for (let index = 0; index < 3; index++) {
                pulled.push(index)
                yield String(index)
              }
            }),
        })
      })

      const reader = bodyStream(
        (await dispatch({ url: '/lazy' })).body
      ).getReader()

      expect(pulled).toEqual([])
      expect(await readChunk(reader)).toBe('0')
      expect(pulled).toEqual([0])
    })

    it('returns a 500 error when the source function throws synchronously', async () => {
      const logger = silentLogger()
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/broken',
            handler: () =>
              stream(() => {
                throw new Error('Cannot open export')
              }),
          })
        },
        { logger }
      )

      const res = await inject({ url: '/broken' })

      expect(res.status).toBe(500)
      expect(res.body).toMatchObject({ error: 'INTERNAL_ERROR' })
    })

    it('rejects invalid sources', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/invalid',
          // @ts-expect-error not a stream source
          handler: () => stream(42),
        })
      })

      expect((await inject({ url: '/invalid' })).status).toBe(500)
    })

    it('errors the stream and reports failures after the response started', async () => {
      const logger = silentLogger()
      const onError = vi.fn()
      const failure = new Error('Database connection lost')
      let cleanedUp = false

      const { dispatch } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/export',
            handler: () =>
              stream(async function* () {
                try {
                  yield 'first row\n'
                  throw failure
                } finally {
                  cleanedUp = true
                }
              }),
          })
        },
        { logger, onError }
      )

      const res = await dispatch({ url: '/export' })
      expect(res.status).toBe(200)

      const reader = bodyStream(res.body).getReader()
      expect(await readChunk(reader)).toBe('first row\n')
      await expect(reader.read()).rejects.toBe(failure)

      expect(cleanedUp).toBe(true)
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
      expect(onError.mock.calls[0]?.[0]).toBe(failure)
      expect(logger.entries).toContainEqual({
        level: 'error',
        args: [failure, 'Error while streaming the response'],
      })
    })

    it('errors the stream on invalid chunks', async () => {
      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({
          path: '/numbers',
          // @ts-expect-error numbers are not valid chunks
          handler: () => stream([1, 2]),
        })
      })

      const reader = bodyStream(
        (await dispatch({ url: '/numbers' })).body
      ).getReader()

      await expect(reader.read()).rejects.toThrow(
        'Stream chunks must be strings or Uint8Array'
      )
    })

    it('releases the source when the consumer cancels the stream', async () => {
      let cleanedUp = false
      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({
          path: '/endless',
          handler: () =>
            stream(async function* () {
              try {
                for (let index = 0; ; index++) yield String(index)
              } finally {
                cleanedUp = true
              }
            }),
        })
      })

      const reader = bodyStream(
        (await dispatch({ url: '/endless' })).body
      ).getReader()
      expect(await readChunk(reader)).toBe('0')

      await reader.cancel()

      await vi.waitFor(() => expect(cleanedUp).toBe(true))
    })

    it('cancels ReadableStream sources with the consumer', async () => {
      const cancel = vi.fn()
      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({
          path: '/readable',
          handler: () =>
            stream(
              new ReadableStream<string>({
                pull: (controller) => controller.enqueue('tick'),
                cancel,
              })
            ),
        })
      })

      const reader = bodyStream(
        (await dispatch({ url: '/readable' })).body
      ).getReader()
      expect(await readChunk(reader)).toBe('tick')

      await reader.cancel('client gone')

      await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('client gone'))
    })
  })

  describe('req.signal', () => {
    it('is exposed to middlewares and handlers', async () => {
      const controller = new AbortController()
      const signals: AbortSignal[] = []

      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/signal',
          middlewares: [({ req }) => void signals.push(req.signal)],
          handler: ({ req }) => {
            signals.push(req.signal)
            return { aborted: req.signal.aborted }
          },
        })
      })

      const res = await inject({ url: '/signal', signal: controller.signal })

      expect(res.body).toEqual({ aborted: false })
      expect(signals).toEqual([controller.signal, controller.signal])
    })

    it('never aborts when the adapter does not provide one', async () => {
      let signal: AbortSignal | undefined
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/signal',
          handler: ({ req }) => {
            signal = req.signal
            return null
          },
        })
      })

      await inject({ url: '/signal' })

      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal?.aborted).toBe(false)
    })

    it('closes the stream and releases the source when the client disconnects', async () => {
      const controller = new AbortController()
      let cleanedUp = false
      let sourceSignal: AbortSignal | undefined

      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({
          path: '/feed',
          handler: () =>
            stream(async function* ({ signal }) {
              sourceSignal = signal
              try {
                yield 'first'
                await waitForAbort(signal)
                yield 'never sent'
              } finally {
                cleanedUp = true
              }
            }),
        })
      })

      const res = await dispatch({ url: '/feed', signal: controller.signal })
      const reader = bodyStream(res.body).getReader()

      expect(await readChunk(reader)).toBe('first')
      expect(sourceSignal).toBe(controller.signal)

      const pending = reader.read()
      controller.abort()

      expect(await pending).toEqual({ done: true, value: undefined })
      await vi.waitFor(() => expect(cleanedUp).toBe(true))
    })

    it('closes the stream immediately when the client is already gone', async () => {
      const controller = new AbortController()
      controller.abort()

      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({ path: '/late', handler: () => stream(['data']) })
      })

      const res = await dispatch({ url: '/late', signal: controller.signal })
      const reader = bodyStream(res.body).getReader()

      expect(await readChunk(reader)).toBeUndefined()
    })

    it('is typed on the request', () => {
      expectTypeOf<DotpressRequest['signal']>().toEqualTypeOf<AbortSignal>()
    })
  })

  describe('sse()', () => {
    it('sets the event stream headers', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/events',
          handler: () => sse([], { heartbeat: false }),
        })
      })

      const res = await inject({ url: '/events' })

      expect(res.status).toBe(200)
      expect(res.kind).toBe('stream')
      expect(res.headers).toMatchObject({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      })
      expect(res.text).toBe('')
    })

    it('encodes events', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/events',
          handler: () =>
            sse(
              async function* () {
                yield 'hello'
                yield { event: 'order', id: 42, data: { id: 42, total: 9.5 } }
                yield { data: 'line 1\nline 2\r\nline 3' }
                yield { retry: 5000, comment: 'reconnect slowly' }
              },
              { heartbeat: false }
            ),
        })
      })

      const res = await inject({ url: '/events' })

      expect(res.text).toBe(
        [
          'data: hello\n\n',
          'event: order\nid: 42\ndata: {"id":42,"total":9.5}\n\n',
          'data: line 1\ndata: line 2\ndata: line 3\n\n',
          ': reconnect slowly\nretry: 5000\n\n',
        ].join('')
      )
    })

    it('sends one chunk per event', async () => {
      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({
          path: '/events',
          handler: () => sse(['a', 'b'], { heartbeat: false }),
        })
      })

      const reader = bodyStream(
        (await dispatch({ url: '/events' })).body
      ).getReader()

      expect(await readChunk(reader)).toBe('data: a\n\n')
      expect(await readChunk(reader)).toBe('data: b\n\n')
      expect(await readChunk(reader)).toBeUndefined()
    })

    it('errors the stream on invalid events', async () => {
      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({
          path: '/events',
          handler: () =>
            sse([{ event: 'bad\nevent', data: 'x' }], { heartbeat: false }),
        })
      })

      const reader = bodyStream(
        (await dispatch({ url: '/events' })).body
      ).getReader()

      await expect(reader.read()).rejects.toThrow('Invalid SSE "event" field')
    })

    it.each([
      [{}, 'at least one field'],
      [{ retry: -1 }, 'Invalid SSE "retry" field'],
      [{ id: 'a\0b' }, 'Invalid SSE "id" field'],
      [{ data: () => {} }, 'not serializable'],
    ])('rejects the event %j', async (event, message) => {
      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({
          path: '/events',
          handler: () => sse([event], { heartbeat: false }),
        })
      })

      const reader = bodyStream(
        (await dispatch({ url: '/events' })).body
      ).getReader()

      await expect(reader.read()).rejects.toThrow(message)
    })

    it('sends heartbeat comments while the source is idle', async () => {
      const controller = new AbortController()
      const { dispatch } = await createTestApp((router) => {
        router.defineRoute({
          path: '/events',
          handler: () =>
            sse(
              async function* ({ signal }) {
                yield 'ready'
                await waitForAbort(signal)
              },
              { heartbeat: 10 }
            ),
        })
      })

      const reader = bodyStream(
        (await dispatch({ url: '/events', signal: controller.signal })).body
      ).getReader()

      expect(await readChunk(reader)).toBe('data: ready\n\n')
      expect(await readChunk(reader)).toBe(':\n\n')
      expect(await readChunk(reader)).toBe(':\n\n')

      controller.abort()
      expect(await readChunk(reader)).toBeUndefined()
    })

    it('rejects invalid heartbeat intervals', () => {
      expect(() => sse([], { heartbeat: 0 })).toThrow(RangeError)
      expect(() => sse([], { heartbeat: Number.NaN })).toThrow(RangeError)
    })

    it('can be returned by routes with a response schema', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/events',
          schema: (z) => ({ response: z.object({ id: z.string() }) }),
          handler: () => sse(['ok'], { heartbeat: false }),
        })
      })

      expect((await inject({ url: '/events' })).text).toBe('data: ok\n\n')
    })

    it('can be returned by middlewares', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/events',
          middlewares: [() => sse(['from middleware'], { heartbeat: false })],
          handler: () => ({ unreachable: true }),
        })
      })

      expect((await inject({ url: '/events' })).text).toBe(
        'data: from middleware\n\n'
      )
    })
  })
})
