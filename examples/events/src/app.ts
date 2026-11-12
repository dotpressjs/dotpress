import { createApp, type HttpAdapter, type Logger } from '@dotpress/core'
import type { EventBus } from '@dotpress/events'
import { eventsPlugin } from '@dotpress/events/plugin'
import { createOrderStore, type OrderStore } from './orders.ts'
import { ordersRouter } from './routes.ts'

export interface OrdersAppOptions<TAdapter extends HttpAdapter> {
  adapter: TAdapter
  /** The bus of `bus.ts`, or a fake bus in tests. */
  events: EventBus
  store?: OrderStore
  logger?: Logger
}

/**
 * Creates the app on any adapter: Fastify in `server.ts`, the memory
 * adapter of `@dotpress/testing` in the tests.
 */
export const createOrdersApp = <TAdapter extends HttpAdapter>({
  adapter,
  events,
  store = createOrderStore(),
  logger,
}: OrdersAppOptions<TAdapter>) =>
  createApp({
    adapter,
    ...(logger && { logger }),
    routers: [ordersRouter(store)],
    // ctx.events: logs with the request logger, and adds the request ID to
    // the metadata of the events (requestId), for the logs of the listeners.
    plugins: [eventsPlugin(events)],
  })
