import type { AddressInfo } from 'node:net'
import { fastifyAdapter } from '@dotpress/adapter-fastify'
import { createMemoryLogger } from '@dotpress/testing'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createOrdersApp } from '../src/app.ts'
import { createBus, createTransport } from '../src/bus.ts'
import { startWarehouse } from './support.ts'

// `npm run dev` without Redis: Fastify, and the listeners in the same
// process.
let baseUrl: string
let warehouse: Awaited<ReturnType<typeof startWarehouse>>
let close: () => Promise<void>

beforeAll(async () => {
  warehouse = await startWarehouse()
  vi.stubEnv('WAREHOUSE_URL', warehouse.url)

  const transport = createTransport({})
  expect(transport.kind).toBe('memory')

  const logger = createMemoryLogger()
  const app = await createOrdersApp({
    adapter: fastifyAdapter(),
    events: createBus(transport, { logger }),
    logger,
  })
  await app.listen(0, '127.0.0.1')

  const { port } = app.native().server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
  close = async () => {
    await app.close()
    await transport.close()
    await warehouse.close()
    vi.unstubAllEnvs()
  }
})

afterAll(() => close())

it('places an order over HTTP, and notifies the warehouse', async () => {
  const res = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ sku: 'BOOK-1', quantity: 1 }] }),
  })
  expect(res.status).toBe(201)
  const order = (await res.json()) as { id: string }

  await warehouse.received(1)
  expect(warehouse.requests[0]?.body).toMatchObject({ orderId: order.id })
})
