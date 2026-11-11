import { createRouter } from '@dotpress/core'
import { createTestApp, expectEventEmitted } from '@dotpress/testing'
import { describe, expect, it } from 'vitest'
import {
  createEventBus,
  createFakeEventBus,
  defineListener,
} from '../src/index.js'
import { eventsPlugin } from '../src/plugin.js'
import { createRecordingTransport, userCreated } from './support.js'

const setup = async (withPlugin = true) => {
  const transport = createRecordingTransport()
  const events = createEventBus({
    transport,
    listeners: [
      defineListener(userCreated, {
        name: 'send-welcome-mail',
        handle: () => {},
      }),
    ],
  })
  const router = createRouter()
  router.defineRoute({
    method: 'post',
    path: '/users',
    handler: async ({ events: bus }) => {
      const { messages } = await bus.emit(userCreated, {
        userId: '42',
      })
      return { messages: messages.length }
    },
  })
  const app = await createTestApp({
    routers: [router],
    plugins: withPlugin ? [eventsPlugin(events)] : [],
  })
  return { ...app, transport, events }
}

describe('eventsPlugin()', () => {
  it('provides ctx.events, with the request ID and logger', async () => {
    const { fetch, transport, logger, close } = await setup()
    const res = await fetch('/users', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messages: 1 })
    const requestId = res.headers.get('x-request-id')
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(transport.sent[0]?.envelopes[0]?.metadata).toEqual({ requestId })
    expect(
      logger.entries.filter(({ args }) => args[1] === 'Event emitted')
    ).toHaveLength(1)
    await close()
  })

  it('exposes the bus on the plugin', () => {
    const events = createEventBus({
      transport: createRecordingTransport(),
      listeners: [],
    })
    const plugin = eventsPlugin(events)
    expect(plugin.name).toBe('events')
    expect(plugin.events).toBe(events)
  })

  it('fails clearly when the plugin is not installed', async () => {
    const { fetch, logger, close } = await setup(false)
    const res = await fetch('/users', { method: 'POST' })
    expect(res.status).toBe(500)
    const [error] = logger.entries.find(({ level }) => level === 'error')
      ?.args as [Error]
    expect(error.message).toContain('eventsPlugin')
    await close()
  })

  it('rejects a value that is not a bus', () => {
    expect(() => eventsPlugin({} as never)).toThrow(
      new TypeError(
        'eventsPlugin(): expected an event bus created by createEventBus().'
      )
    )
    expect(() => eventsPlugin(undefined as never)).toThrow(TypeError)
  })
})

describe('eventsPlugin() with a fake event bus', () => {
  it('records the emissions of the routes, with the request ID', async () => {
    const events = createFakeEventBus()
    const router = createRouter()
    router.defineRoute({
      method: 'post',
      path: '/users',
      handler: async ({ events: bus }) => {
        await bus.emit(userCreated, { userId: '42' })
        return { ok: true }
      },
    })
    const { fetch, close } = await createTestApp({
      routers: [router],
      plugins: [eventsPlugin(events)],
    })
    const res = await fetch('/users', { method: 'POST' })
    expect(res.status).toBe(200)
    expectEventEmitted(
      events,
      userCreated,
      { userId: '42' },
      {
        times: 1,
        metadata: { requestId: expect.any(String) },
      }
    )
    await close()
  })
})
