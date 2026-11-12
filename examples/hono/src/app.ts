import type { HonoAdapterOptions } from '@dotpress/adapter-hono'
import { createApp, type HttpAdapter, type Logger } from '@dotpress/core'
import type { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { createNoteStore } from './notes.ts'
import { notesRouter } from './routes.ts'

/** Options of the Hono adapter, the same on Node.js and AWS Lambda. */
export const honoOptions: HonoAdapterOptions<Hono> = {
  // Native Hono middlewares and routes, before the Dotpress routes.
  beforeRoutes: (app) => {
    app.use('*', secureHeaders())
    app.get('/health', (c) => c.json({ status: 'ok' }))
  },
}

/**
 * Creates the app on a Hono adapter: `honoAdapter()` of
 * `@dotpress/adapter-hono/node` in `node.ts`, of `@dotpress/adapter-hono`
 * in `lambda.ts` and the tests.
 */
export const createNotesApp = <TAdapter extends HttpAdapter>(
  adapter: TAdapter,
  options: { logger?: Logger } = {}
) =>
  createApp({
    adapter,
    ...(options.logger && { logger: options.logger }),
    routers: [notesRouter(createNoteStore())],
  })
