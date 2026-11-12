import { defineEvent, defineListener } from '@dotpress/events'
import { z } from 'zod'

// Shared by the API, which emits, and by the worker, which runs the
// listeners.

/** A fact: an order was placed. Payloads travel as JSON. */
export const orderPlaced = defineEvent({
  name: 'order.placed',
  schema: z.object({
    orderId: z.uuid(),
    items: z.array(z.object({ sku: z.string(), quantity: z.number().int() })),
  }),
})

// Each listener gets its own message: it is retried on its own. `load`
// keeps the code of the listeners out of the API, which only needs their
// names.
export const sendOrderConfirmation = defineListener(orderPlaced, {
  name: 'send-order-confirmation',
  load: () => import('./listeners/send-order-confirmation.ts'),
})

export const notifyWarehouse = defineListener(orderPlaced, {
  name: 'notify-warehouse',
  load: () => import('./listeners/notify-warehouse.ts'),
})

export const listeners = [sendOrderConfirmation, notifyWarehouse]
