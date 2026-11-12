import type { EventPayload, ListenerContext } from '@dotpress/events'
import type { orderPlaced } from '../events.ts'

/** Sends the confirmation of an order. */
export default async ({
  payload,
  logger,
}: ListenerContext<EventPayload<typeof orderPlaced>>) => {
  // Replace with your mailer (see the mailer example).
  logger.info({ orderId: payload.orderId }, 'Order confirmation sent')
}
