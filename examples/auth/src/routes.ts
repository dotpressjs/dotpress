import {
  conflictError,
  createRouter,
  empty,
  forbiddenError,
  notFoundError,
} from '@dotpress/core'
import {
  isPasswordTooLong,
  requireAuth,
  requireRole,
  type Auth,
} from '@dotpress/auth'
import { z } from 'zod'
import type { Note as StoredNote, NoteStore } from './notes.ts'
import type { Store, User } from './store.ts'

// bcrypt reads 72 bytes at most: longer passwords get a validation error
// instead of being truncated.
const Password = z
  .string()
  .min(12)
  .refine((password) => !isPasswordTooLong(password), 'Password too long')

const PublicUser = z
  .object({
    id: z.uuid(),
    username: z.string(),
    role: z.enum(['user', 'admin']),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'User' })

const Note = z
  .object({ id: z.uuid(), text: z.string(), createdAt: z.iso.datetime() })
  .meta({ id: 'Note' })

/** Never returns the password hash. */
const toPublicUser = ({ id, username, role, createdAt }: User) => ({
  id,
  username,
  role,
  createdAt,
})

/** The owner is the authenticated user: not returned. */
const toPublicNote = ({ id, text, createdAt }: StoredNote) => ({
  id,
  text,
  createdAt,
})

const USERNAME_TAKEN = 'This username is already taken'
const NOTE_NOT_FOUND = 'Note not found'

/** Sign-up and password change. */
export const usersRouter = (auth: Auth, store: Store) => {
  const router = createRouter()

  router.defineRoute({
    method: 'post',
    path: '/users',
    status: 201,
    schema: (z) => ({
      body: z.object({
        username: z.string().trim().min(3).max(50),
        password: Password,
      }),
      response: PublicUser,
    }),
    meta: {
      summary: 'Sign up',
      tags: ['users'],
      responses: { 409: USERNAME_TAKEN },
    },
    handler: async ({ req }) => {
      if (await store.users.findByUsername(req.body.username)) {
        return conflictError(USERNAME_TAKEN)
      }
      const user = await store.users.create({
        username: req.body.username,
        passwordHash: await auth.hashPassword(req.body.password),
      })
      return toPublicUser(user)
    },
  })

  router.defineRoute({
    method: 'put',
    path: '/users/me/password',
    status: 204,
    // ctx.user is defined and typed in the handler.
    middlewares: [requireAuth],
    schema: (z) => ({
      body: z.object({ currentPassword: z.string(), newPassword: Password }),
    }),
    meta: {
      summary: 'Change the password, and log out every device',
      tags: ['users'],
      responses: { 403: 'Invalid current password' },
    },
    handler: async ({ req, user }) => {
      const stored = await store.users.get(user.id)
      if (
        !(await auth.verifyPassword(
          req.body.currentPassword,
          stored?.passwordHash
        ))
      ) {
        return forbiddenError('Invalid current password')
      }
      await store.users.setPasswordHash(
        user.id,
        await auth.hashPassword(req.body.newPassword)
      )
      // A stolen session must not survive a password change.
      await auth.settings.dataProvider.revokeTokens(user.id)
      return empty()
    },
  })

  return router
}

/** Notes of the authenticated user: every route of the group requires it. */
export const notesRouter = (notes: NoteStore) => {
  const router = createRouter()
  const group = router.createGroup('/notes', [requireAuth])

  group.defineRoute({
    path: '/',
    schema: (z) => ({ response: z.array(Note) }),
    meta: { summary: 'List my notes', tags: ['notes'] },
    handler: async ({ user }) =>
      (await notes.listByOwner(user.id)).map(toPublicNote),
  })

  group.defineRoute({
    method: 'post',
    path: '/',
    status: 201,
    schema: (z) => ({
      body: z.object({ text: z.string().trim().min(1).max(1000) }),
      response: Note,
    }),
    meta: { summary: 'Create a note', tags: ['notes'] },
    handler: async ({ req, user }) =>
      toPublicNote(await notes.create(user.id, req.body.text)),
  })

  group.defineRoute({
    path: '/:id',
    schema: () => ({ response: Note }),
    meta: {
      summary: 'Get a note',
      tags: ['notes'],
      responses: { 404: NOTE_NOT_FOUND },
    },
    handler: async ({ req, user }) => {
      const note = await notes.get(req.params.id)
      // The notes of other users answer 404, not 403: their existence is
      // not revealed.
      if (!note || note.ownerId !== user.id) {
        return notFoundError(NOTE_NOT_FOUND)
      }
      return toPublicNote(note)
    },
  })

  return router
}

/** Administration: admins only (401 without user, 403 without the role). */
export const adminRouter = (store: Store) => {
  const router = createRouter()

  router.createGroup('/admin', [requireRole('admin')]).defineRoute({
    path: '/users',
    schema: (z) => ({ response: z.array(PublicUser) }),
    meta: { summary: 'List the users', tags: ['admin'] },
    handler: async () => (await store.users.list()).map(toPublicUser),
  })

  return router
}
