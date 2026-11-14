import { describe, expect, it, vi } from 'vitest'
import { createFetchTarget, createHttpTarget } from '../src/conformance.js'

describe('test targets', () => {
  it('take their close() in the options, doing nothing by default', async () => {
    const close = vi.fn(async () => {})
    const target = createFetchTarget(async () => new Response('ok'), {
      close,
    })

    expect(await (await target.fetch('/')).text()).toBe('ok')
    await target.close()
    expect(close).toHaveBeenCalledOnce()

    await expect(
      createHttpTarget('http://127.0.0.1:1').close()
    ).resolves.toBeUndefined()
  })

  it('reject unknown options', () => {
    expect(() =>
      createHttpTarget('http://127.0.0.1:1', { stop: async () => {} } as never)
    ).toThrow(new TypeError('createHttpTarget(): unknown option "stop".'))
    expect(() =>
      createFetchTarget(async () => new Response(), (async () => {}) as never)
    ).toThrow(new TypeError('createFetchTarget(): options must be an object.'))
  })
})
