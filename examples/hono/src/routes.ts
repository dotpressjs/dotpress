import { createRouter, notFoundError } from '@dotpress/core'
import { z } from 'zod'
import type { NoteStore } from './notes.ts'

const Note = z.object({
  id: z.uuid(),
  text: z.string(),
  createdAt: z.iso.datetime(),
})

/** Dotpress routes: they know nothing about Hono or AWS Lambda. */
export const notesRouter = (store: NoteStore) => {
  const router = createRouter()

  router.defineRoute({
    path: '/notes',
    schema: (z) => ({ response: z.array(Note) }),
    handler: () => store.list(),
  })

  router.defineRoute({
    method: 'post',
    path: '/notes',
    status: 201,
    schema: (z) => ({
      body: z.object({ text: z.string().trim().min(1).max(1000) }),
      response: Note,
    }),
    handler: ({ req }) => store.create(req.body.text),
  })

  router.defineRoute({
    path: '/notes/:id',
    schema: () => ({ response: Note }),
    handler: async ({ req }) =>
      (await store.get(req.params.id)) ?? notFoundError('Note not found'),
  })

  return router
}
