import { createFakeEventBus } from '@dotpress/events'
import {
  createMemoryLogger,
  expectEventEmitted,
  expectEventNotEmitted,
  memoryAdapter,
} from '@dotpress/testing'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createOrdersApp } from '../src/app.ts'
import { orderPlaced } from '../src/events.ts'
import type { Order } from '../src/orders.ts'

// The routes, with a fake event bus: it checks each emission like a real
// bus (event, payload), records it, and runs no listener.
let adapter: ReturnType<typeof memoryAdapter>
let events: ReturnType<typeof createFakeEventBus>
let close: () => Promise<void>

beforeEach(async () => {
  adapter = memoryAdapter()
  events = createFakeEventBus()
  const app = await createOrdersApp({
    adapter,
    events,
    logger: createMemoryLogger(),
  })
  close = () => app.close()
})

afterEach(() => close())

const placeOrder = (body: unknown) =>
  adapter.fetch(
    new Request('http://localhost/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

it('emits order.placed when an order is placed', async () => {
  const res = await placeOrder({ items: [{ sku: 'BOOK-1', quantity: 2 }] })
  expect(res.status).toBe(201)
  const order = (await res.json()) as Order

  const emission = expectEventEmitted(
    events,
    orderPlaced,
    { orderId: order.id, items: [{ sku: 'BOOK-1', quantity: 2 }] },
    { times: 1 }
  )
  // eventsPlugin links the event to the request, for the logs of the
  // listeners.
  expect(emission.metadata.requestId).toEqual(expect.any(String))

  const read = await adapter.fetch(
    new Request(`http://localhost/orders/${order.id}`)
  )
  expect(await read.json()).toEqual(order)
})

it('emits nothing for an invalid order', async () => {
  const res = await placeOrder({ items: [] })

  expect(res.status).toBe(400)
  expectEventNotEmitted(events, orderPlaced)
})
