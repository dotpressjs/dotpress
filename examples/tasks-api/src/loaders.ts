import { defineMemo, type Memo } from '@dotpress/cache'
import {
  defineMiddleware,
  notFoundError,
  unauthorizedError,
  type RequestContext,
} from '@dotpress/core'
import { z } from 'zod'
import type { ProjectRepository } from './projects/repository.ts'
import type { UserRepository } from './users/repository.ts'

/**
 * Values loaded once per request (`ctx.memo`): the routes, the access
 * checks and the views share them, without passing them around.
 */
export const createLoaders = (
  projects: ProjectRepository,
  users: UserRepository
) => ({
  /** The role of a user in a project: checked by every project route. */
  role: defineMemo({
    name: 'project-role',
    load: (projectId: string, userId: string) =>
      projects.findRole(projectId, userId),
  }),
  /** Users by id, batched: the assignees of a list in one query. */
  user: defineMemo({
    name: 'user',
    batch: async (ids: readonly string[]) => {
      const found = await users.findManyById(ids)
      return new Map(found.map((user) => [user.id, user]))
    },
  }),
})

export type Loaders = ReturnType<typeof createLoaders>

/** A user as other members see it: no email address. */
export const PersonView = z
  .object({ id: z.uuid(), name: z.string() })
  .meta({ id: 'Person' })

export const personOf = async (
  memo: Memo,
  loaders: Loaders,
  userId: string | null
) => {
  if (userId === null) return null
  const user = await memo(loaders.user, userId)
  return user ? { id: user.id, name: user.name } : null
}

/**
 * The role of the current user in a project, or undefined for a
 * non-member: the routes then answer 404, so that the existence of the
 * project is not revealed.
 */
export const roleIn = (
  ctx: Pick<RequestContext, 'memo'> & { user: { id: string } },
  loaders: Loaders,
  projectId: string
) => ctx.memo(loaders.role, projectId, ctx.user.id)

/**
 * Middleware of the routes of a project (`/projects/:projectId/...`): a
 * non-member gets 404. The role is memoized, so the handlers read it again
 * without a query.
 */
export const requireMember = (loaders: Loaders) =>
  defineMiddleware(async (ctx) => {
    const { projectId } = ctx.req.params
    if (!ctx.user) return unauthorizedError()
    if (!projectId || !(await ctx.memo(loaders.role, projectId, ctx.user.id))) {
      return notFoundError('Project not found')
    }
  })
