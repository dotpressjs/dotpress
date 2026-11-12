import { createRouter, notFoundError } from '@dotpress/core'
import { z } from 'zod'
import { orderPlaced } from './events.ts'
import type { OrderStore } from './orders.ts'

const Order = z
  .object({
    id: z.uuid(),
    items: z.array(z.object({ sku: z.string(), quantity: z.number().int() })),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Order' })

const ORDER_NOT_FOUND = 'Order not found'

export const ordersRouter = (store: OrderStore) => {
  const router = createRouter()
  const orders = router.createGroup('/orders')

  orders.defineRoute({
    method: 'post',
    path: '/',
    status: 201,
    schema: (z) => ({
      body: z.object({
        items: z
          .array(
            z.object({
              sku: z.string().trim().min(1).max(64),
              quantity: z.number().int().min(1).max(1000),
            })
          )
          .min(1),
      }),
      response: Order,
    }),
    meta: { summary: 'Place an order', tags: ['orders'] },
    // ctx.events comes from eventsPlugin.
    handler: async ({ req, events }) => {
      // Store first, then emit: an event describes something that
      // happened. With a database, emit after the transaction commits.
      const order = await store.create(req.body.items)
      // Returns once the messages are queued: the listeners run later, in
      // the worker, and the client does not wait for them.
      await events.emit(orderPlaced, { orderId: order.id, items: order.items })
      return order
    },
  })

  orders.defineRoute({
    path: '/:id',
    schema: () => ({ response: Order }),
    meta: {
      summary: 'Get an order',
      tags: ['orders'],
      responses: { 404: ORDER_NOT_FOUND },
    },
    handler: async ({ req }) =>
      (await store.get(req.params.id)) ?? notFoundError(ORDER_NOT_FOUND),
  })

  return router
}
