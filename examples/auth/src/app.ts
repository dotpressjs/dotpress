import { authPlugin } from '@dotpress/auth'
import { createApp, type HttpAdapter, type Logger } from '@dotpress/core'
import { openapiPlugin } from '@dotpress/openapi'
import { createAuthService, type AuthOptions } from './auth.ts'
import { createNoteStore, type NoteStore } from './notes.ts'
import { adminRouter, notesRouter, usersRouter } from './routes.ts'

export interface NotesAppOptions<
  TAdapter extends HttpAdapter,
> extends AuthOptions {
  adapter: TAdapter
  notes?: NoteStore
  logger?: Logger
}

/**
 * Creates the app on any adapter: Express in `server.ts`, the memory
 * adapter of `@dotpress/testing` in the tests.
 */
export const createNotesApp = <TAdapter extends HttpAdapter>({
  adapter,
  notes = createNoteStore(),
  logger,
  ...authOptions
}: NotesAppOptions<TAdapter>) => {
  const auth = createAuthService(authOptions)

  return createApp({
    adapter,
    ...(logger && { logger }),
    routers: [
      usersRouter(auth, authOptions.store),
      notesRouter(notes),
      adminRouter(authOptions.store),
    ],
    plugins: [
      // Reads the access token of every request (ctx.user, ctx.auth), and
      // serves /auth/login, /auth/refresh, /auth/me, /auth/restore and
      // /auth/logout.
      authPlugin(auth),
      // The routes guarded by requireAuth and requireRole() are documented
      // as secured: Scalar shows an Authorize button.
      openapiPlugin({
        info: { title: 'Notes API', version: '1.0.0' },
        tags: [
          { name: 'auth', description: 'Sessions' },
          { name: 'users', description: 'Accounts' },
          { name: 'notes', description: 'Private notes' },
          { name: 'admin', description: 'Administration' },
        ],
      }),
    ],
  })
}
