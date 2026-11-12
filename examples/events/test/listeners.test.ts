import { createMemoryTransport, type FailureHook } from '@dotpress/events'
import { createMemoryLogger } from '@dotpress/testing'
import { afterEach, expect, it, vi } from 'vitest'
import { createBus } from '../src/bus.ts'
import { orderPlaced } from '../src/events.ts'
import { startWarehouse } from './support.ts'

// The listeners, run by an in-memory queue: same retries as a real queue,
// without Redis. No wait between the attempts.
let warehouse: Awaited<ReturnType<typeof startWarehouse>>

afterEach(async () => {
  vi.unstubAllEnvs()
  await warehouse.close()
})

const setup = async (statuses: number[]) => {
  warehouse = await startWarehouse(statuses)
  vi.stubEnv('WAREHOUSE_URL', warehouse.url)

  const transport = createMemoryTransport({ retryDelay: () => 0 })
  const logger = createMemoryLogger()
  const onFailure = vi.fn<FailureHook>()
  const events = createBus(transport, { logger, onFailure })
  return { transport, logger, onFailure, events }
}

const payload = {
  orderId: '0b7c4a8e-2f4d-4c55-9a8e-6f1d1b2c3d4e',
  items: [{ sku: 'BOOK-1', quantity: 2 }],
}

it('runs every listener of the event', async () => {
  const { transport, logger, events } = await setup([])

  const { messages } = await events.emit(orderPlaced, payload)
  await transport.drain()

  expect(messages.map((message) => message.listener)).toEqual([
    'send-order-confirmation',
    'notify-warehouse',
  ])
  expect(warehouse.requests).toEqual([
    {
      headers: expect.objectContaining({
        'idempotency-key': messages[1]?.id,
      }),
      body: payload,
    },
  ])
  expect(logger.entries).toContainEqual({
    level: 'info',
    args: [{ orderId: payload.orderId }, 'Order confirmation sent'],
  })
})

it('retries the listener that failed, with the same idempotency key', async () => {
  // The warehouse fails once, then accepts.
  const { transport, onFailure, events } = await setup([503])

  await events.emit(orderPlaced, payload)
  await transport.drain()

  expect(warehouse.requests).toHaveLength(2)
  const [first, second] = warehouse.requests
  expect(second?.headers['idempotency-key']).toBe(
    first?.headers['idempotency-key']
  )
  expect(onFailure).toHaveBeenCalledOnce()
  expect(onFailure.mock.calls[0]?.[1]).toMatchObject({
    reason: 'listener-error',
    attempt: 1,
    final: false,
  })
})

it('gives up after the last attempt', async () => {
  const { transport, onFailure, events } = await setup([500, 500, 500])

  await events.emit(orderPlaced, payload)
  await transport.drain()

  // 3 attempts: the default of the memory transport, and of BullMQ.
  expect(warehouse.requests).toHaveLength(3)
  expect(onFailure).toHaveBeenCalledTimes(3)
  expect(onFailure.mock.calls[2]?.[1]).toMatchObject({
    attempt: 3,
    final: true,
  })
})
