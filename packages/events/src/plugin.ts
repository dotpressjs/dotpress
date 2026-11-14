import { declareContextKey, definePlugin } from '@dotpress/core'
import type { EventBus } from './bus.js'

declare module '@dotpress/core' {
  interface RequestContext {
    /**
     * Event bus (`eventsPlugin`): logs with the request logger, and adds
     * the request ID to the metadata of emitted events.
     */
    events: EventBus
  }
}

// Accessing ctx.events without the plugin throws an explicit error.
declareContextKey('events', 'eventsPlugin')

/**
 * Provides `ctx.events` to routes and middlewares. Emitted events carry the
 * request ID in their metadata (`requestId`), and are logged with the
 * request logger. The transports of the bus are closed with the app
 * (`bus.close()`).
 *
 * ```ts
 * await createApp({ adapter, plugins: [eventsPlugin(events)] })
 *
 * defineRoute({
 *   method: 'post',
 *   path: '/users',
 *   handler: async ({ events, body }) => {
 *     const user = await createUser(body)
 *     await events.emit(userCreated, { userId: user.id })
 *     return user
 *   },
 * })
 * ```
 */
export const eventsPlugin = (events: EventBus) => {
  if (
    typeof events?.withContext !== 'function' ||
    typeof events.close !== 'function'
  ) {
    throw new TypeError(
      'eventsPlugin(): expected an event bus created by createEventBus().'
    )
  }
  return definePlugin({
    name: 'events',
    events,
    setup(api) {
      // The transports are closed with the app.
      api.hooks.onClose(() => events.close())
      api.decorateContext('events', (ctx) =>
        events.withContext({
          logger: ctx.logger,
          metadata: { requestId: ctx.requestId },
        })
      )
    },
  })
}
