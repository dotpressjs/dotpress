import type { EventPayload, ListenerContext } from '@dotpress/events'
import type { orderPlaced } from '../events.ts'

/**
 * Sends the order to the warehouse service (`WAREHOUSE_URL`). When the
 * service fails, the listener throws: the message is retried, then kept in
 * the failed jobs of the queue.
 */
export default async ({
  payload,
  id,
  logger,
}: ListenerContext<EventPayload<typeof orderPlaced>>) => {
  const url = process.env.WAREHOUSE_URL
  if (!url) {
    logger.info(
      { orderId: payload.orderId },
      'WAREHOUSE_URL is not set: the warehouse is not notified'
    )
    return
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // A message can be delivered twice (retry after a timeout): the id
      // is the same for every attempt, so the service ignores duplicates.
      'idempotency-key': id,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`The warehouse answered ${res.status}`)

  logger.info({ orderId: payload.orderId }, 'Warehouse notified')
}
