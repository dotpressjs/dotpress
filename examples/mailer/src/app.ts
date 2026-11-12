import { createApp, type HttpAdapter, type Logger } from '@dotpress/core'
import type { Mailer } from '@dotpress/mailer'
import { mailerPlugin } from '@dotpress/mailer/plugin'
import { contactRouter, previewsRouter } from './routes.ts'

export interface ContactAppOptions<TAdapter extends HttpAdapter> {
  adapter: TAdapter
  mailer: Mailer
  /** Address of the team receiving the messages. */
  contactTo: string
  /** Serves /previews: development only. */
  previews?: boolean
  logger?: Logger
}

/**
 * Creates the app on any adapter: Hono in `server.ts`, the memory adapter
 * of `@dotpress/testing` in the tests.
 */
export const createContactApp = <TAdapter extends HttpAdapter>({
  adapter,
  mailer,
  contactTo,
  previews = false,
  logger,
}: ContactAppOptions<TAdapter>) =>
  createApp({
    adapter,
    ...(logger && { logger }),
    routers: [
      contactRouter(contactTo),
      ...(previews ? [previewsRouter(mailer)] : []),
    ],
    plugins: [mailerPlugin(mailer)],
  })
