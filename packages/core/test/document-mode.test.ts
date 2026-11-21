import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerLazyApp } from '../src/adapter-api.js'
import {
  DOCUMENT_MODE_KEY,
  documentMode,
  type DocumentMode,
} from '../src/document-mode.js'
import { createApp, createRouter, type HttpAdapter } from '../src/index.js'
import { silentLogger } from './support/memory-adapter.js'

const global = globalThis as Record<symbol, unknown>

const enter = (): DocumentMode => {
  const mode: DocumentMode = { apps: [], pending: [] }
  global[DOCUMENT_MODE_KEY] = mode
  return mode
}

afterEach(() => {
  delete global[DOCUMENT_MODE_KEY]
})

const adapterWith = (listen?: HttpAdapter['listen']): HttpAdapter => ({
  name: 'test',
  mount: () => {},
  native: () => undefined,
  ...(listen && { listen }),
})

const create = (adapter: HttpAdapter) =>
  createApp({ adapter, logger: silentLogger(), routers: [createRouter()] })

describe('document mode', () => {
  it('is the global set by dotpress-openapi', () => {
    // The key is a contract with the CLI of @dotpress/openapi.
    expect(DOCUMENT_MODE_KEY).toBe(Symbol.for('dotpress.core.documentMode'))
    expect(documentMode()).toBeUndefined()
    const mode = enter()
    expect(documentMode()).toBe(mode)

    global[DOCUMENT_MODE_KEY] = { apps: [] }
    expect(documentMode()).toBeUndefined()
  })

  it('is off by default: apps listen, and lazy factories wait', async () => {
    const listen = vi.fn(async (port: number) => ({ port, host: '::' }))
    const app = await create(adapterWith(listen))
    expect(await app.listen(3000)).toEqual({ port: 3000, host: '::' })
    expect(listen).toHaveBeenCalledOnce()

    await expect(
      create(adapterWith()).then((a) => a.listen(3000))
    ).rejects.toThrow(
      'app.listen(): the "test" adapter does not start a server.'
    )

    const factory = vi.fn()
    registerLazyApp(factory)
    await Promise.resolve()
    expect(factory).not.toHaveBeenCalled()
  })

  it('records the apps, which start no server', async () => {
    const mode = enter()
    const listen = vi.fn()
    const app = await create(adapterWith(listen))
    const withoutServer = await create(adapterWith())

    expect(mode.apps).toEqual([app, withoutServer])
    expect(await app.listen(3000)).toEqual({ port: 3000, host: 'localhost' })
    expect(await withoutServer.listen(8080, '0.0.0.0')).toEqual({
      port: 8080,
      host: '0.0.0.0',
    })
    expect(listen).not.toHaveBeenCalled()
  })

  it('calls the lazy factories right away', async () => {
    const mode = enter()
    registerLazyApp(() => create(adapterWith()))

    expect(mode.pending).toHaveLength(1)
    await Promise.all(mode.pending)
    expect(mode.apps).toHaveLength(1)
  })

  it('leaves the failure of a lazy factory to the tool', async () => {
    const mode = enter()
    registerLazyApp(() => {
      throw new Error('Missing DATABASE_URL')
    })
    // Not an unhandled rejection, which would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(mode.pending[0]).rejects.toThrow('Missing DATABASE_URL')
  })
})
