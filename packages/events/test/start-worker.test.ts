import { describe, expect, it, vi } from 'vitest'
import {
  createWorker,
  defineListener,
  startWorker,
  type Source,
} from '../src/index.js'
import { createLogger, envelopeOf, userCreated } from './support.js'

const worker = createWorker({
  listeners: [
    defineListener(userCreated, {
      name: 'send-welcome-mail',
      handle: () => {},
    }),
  ],
})

/** A source that handles one message, then waits to be stopped. */
const createSource = () => {
  const results: unknown[] = []
  const source: Source & { results: unknown[] } = {
    kind: 'test',
    results,
    consume: vi.fn(async (bound, { signal }) => {
      results.push(await bound.handle(envelopeOf()))
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }),
  }
  return source
}

describe('startWorker()', () => {
  it('consumes the source until stopped', async () => {
    const source = createSource()
    const logger = createLogger()
    const running = startWorker(worker, source, { logger })
    await vi.waitFor(() => expect(source.results).toHaveLength(1))
    expect(source.results).toEqual([{ status: 'success' }])
    expect(source.consume).toHaveBeenCalledWith(worker, {
      signal: expect.any(AbortSignal),
      logger,
    })

    await running.stop()
    await running.done
    expect(logger.entries).toEqual([
      {
        level: 'info',
        message: 'Event worker started',
        data: { source: 'test', listeners: ['send-welcome-mail'] },
      },
      {
        level: 'info',
        message: 'Event worker stopped',
        data: { source: 'test' },
      },
    ])
  })

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController()
    const running = startWorker(worker, createSource(), {
      signal: controller.signal,
    })
    controller.abort()
    await expect(running.done).resolves.toBeUndefined()
  })

  it('stops at once with an aborted signal', async () => {
    const source = createSource()
    const running = startWorker(worker, source, {
      signal: AbortSignal.abort(),
    })
    await running.done
    const [, { signal }] = vi.mocked(source.consume).mock.calls[0]!
    expect(signal.aborted).toBe(true)
  })

  it('rejects when the source fails', async () => {
    const failure = new Error('connection lost')
    const logger = createLogger()
    const running = startWorker(
      worker,
      { kind: 'broken', consume: () => Promise.reject(failure) },
      { logger }
    )
    await expect(running.done).rejects.toBe(failure)
    expect(logger.entries.at(-1)?.message).toBe('Event worker stopped')
  })

  it.each([
    [
      {},
      createSource(),
      'startWorker(): expected a worker created by createWorker().',
    ],
    [
      null,
      createSource(),
      'startWorker(): expected a worker created by createWorker().',
    ],
    [worker, {}, 'startWorker(): expected a source with a consume() method.'],
    [
      worker,
      undefined,
      'startWorker(): expected a source with a consume() method.',
    ],
  ])('rejects invalid arguments (%#)', (target, source, message) => {
    expect(() => startWorker(target as never, source as never)).toThrow(
      new TypeError(message)
    )
  })

  it('rejects an invalid logger', () => {
    expect(() =>
      startWorker(worker, createSource(), { logger: {} as never })
    ).toThrow(
      'startWorker(): logger must have info(), warn() and error() methods.'
    )
  })
})
