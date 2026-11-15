import { declareContextKey, definePlugin } from '@dotpress/core'
import type { Mailer } from './mailer.js'

declare module '@dotpress/core' {
  interface RequestContext {
    /** Mailer (`mailerPlugin`), logging with the request logger. */
    mailer: Mailer
  }
}

// Accessing ctx.mailer without the plugin throws an explicit error.
declareContextKey('mailer', 'mailerPlugin')

/**
 * Provides `ctx.mailer` to routes and middlewares. Sent messages are
 * logged with the request logger (request ID).
 *
 * ```ts
 * await createApp({ adapter, plugins: [mailerPlugin(mailer)] })
 *
 * defineRoute({
 *   method: 'post',
 *   path: '/invitations',
 *   handler: async ({ mailer, body }) => {
 *     await mailer.send(invitation, { to: body.email, data: { … } })
 *   },
 * })
 * ```
 */
export const mailerPlugin = (mailer: Mailer) => {
  if (typeof mailer?.withContext !== 'function') {
    throw new TypeError(
      'mailerPlugin(): expected a mailer created by createMailer().'
    )
  }
  return definePlugin({
    name: 'mailer',
    mailer,
    setup(api) {
      api.decorateContext('mailer', (ctx) =>
        mailer.withContext({ logger: ctx.logger })
      )
    },
  })
}
