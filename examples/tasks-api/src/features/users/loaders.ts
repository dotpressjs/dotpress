import { defineMemo, type Memo } from '@dotpress/cache'
import { z } from 'zod'
import type { UserRepository } from './repository.ts'

/**
 * Users by id, loaded once per request and in batches (`ctx.memo`): the
 * ids requested together, like the assignees of a list, take one query.
 */
export const userMemo = (users: UserRepository) =>
  defineMemo({
    name: 'user',
    batch: async (ids: readonly string[]) => {
      const found = await users.findManyById(ids)
      return new Map(found.map((user) => [user.id, user]))
    },
  })

export type UserMemo = ReturnType<typeof userMemo>

/** A user as other members see it: no email address. */
export const PersonView = z
  .object({ id: z.uuid(), name: z.string() })
  .meta({ id: 'Person' })

export const personOf = async (
  memo: Memo,
  users: UserMemo,
  userId: string | null
) => {
  if (userId === null) return null
  const user = await memo(users, userId)
  return user ? { id: user.id, name: user.name } : null
}
