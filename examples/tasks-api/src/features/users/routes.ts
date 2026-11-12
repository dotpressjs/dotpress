import { isPasswordTooLong } from '@dotpress/auth'
import { conflictError, createRouter } from '@dotpress/core'
import { z } from 'zod'
import { negotiateLocale } from './locale.ts'
import { LOCALES } from './repository.ts'

export const UserView = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    locale: z.enum(['en', 'fr']),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'User' })

const EMAIL_TAKEN = 'An account already uses this email address'

export const usersRouter = createRouter()

usersRouter.defineRoute({
  method: 'post',
  path: '/users',
  status: 201,
  schema: (z) => ({
    body: z.object({
      email: z.email().max(254),
      name: z.string().trim().min(1).max(100),
      // bcrypt reads 72 bytes at most: longer passwords are refused.
      password: z
        .string()
        .min(12)
        .refine(
          (password) => !isPasswordTooLong(password),
          'Password too long'
        ),
    }),
    response: UserView,
  }),
  meta: {
    summary: 'Sign up',
    description: 'The language of the emails comes from `Accept-Language`.',
    tags: ['users'],
    responses: { 409: EMAIL_TAKEN },
  },
  handler: async ({ req, services: { users, auth } }) => {
    if (await users.findByEmail(req.body.email)) {
      return conflictError(EMAIL_TAKEN)
    }
    return users.create({
      email: req.body.email,
      name: req.body.name,
      passwordHash: await auth.hashPassword(req.body.password),
      locale: negotiateLocale(req.header('accept-language'), LOCALES) ?? 'en',
    })
  },
})
