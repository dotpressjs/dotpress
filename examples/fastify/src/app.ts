import { fastifyAdapter } from '@dotpress/adapter-fastify'
import { createApp, type Logger } from '@dotpress/core'
import Fastify from 'fastify'
import { createNoteStore } from './notes.ts'
import { notesRouter } from './routes.ts'

/**
 * Mounts the Dotpress routes on a Fastify instance, next to its native
 * routes. Used by the server (`server.ts`) and the Lambda handler
 * (`lambda.ts`).
 */
export const createNotesApp = (options: { logger?: Logger } = {}) => {
  // An existing instance: its plugins, hooks and native routes stay.
  const fastify = Fastify()
  fastify.get('/health', async () => ({ status: 'ok' }))

  return createApp({
    adapter: fastifyAdapter({
      app: fastify,
      // Hooks and plugins registered here apply to the Dotpress routes too.
      beforeRoutes: (app) => {
        app.addHook('onRequest', async (request, reply) => {
          reply.header('x-request-id', request.id)
        })
      },
    }),
    ...(options.logger && { logger: options.logger }),
    routers: [notesRouter(createNoteStore())],
  })
}
