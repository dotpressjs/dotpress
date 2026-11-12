import { defineMemo } from '@dotpress/cache'
import {
  defineMiddleware,
  notFoundError,
  unauthorizedError,
  type RequestContext,
} from '@dotpress/core'
import type { ProjectRepository } from './repository.ts'

/**
 * The role of a user in a project, loaded once per request (`ctx.memo`):
 * the middleware, the handlers and the checks of the assignees share it.
 */
export const roleMemo = (projects: ProjectRepository) =>
  defineMemo({
    name: 'project-role',
    load: (projectId: string, userId: string) =>
      projects.findRole(projectId, userId),
  })

/**
 * The role of the current user in a project, or undefined for a
 * non-member: the routes then answer 404, so that the existence of the
 * project is not revealed.
 */
export const roleIn = (
  ctx: Pick<RequestContext, 'memo' | 'services'> & { user: { id: string } },
  projectId: string
) => ctx.memo(ctx.services.loaders.role, projectId, ctx.user.id)

/**
 * Middleware of the routes of a project (`/projects/:projectId/...`): a
 * non-member gets 404. The role is memoized, so the handlers read it again
 * without a query.
 */
export const requireMember = defineMiddleware(async (ctx) => {
  const { projectId } = ctx.req.params
  const { user } = ctx
  if (!user) return unauthorizedError()
  if (!projectId || !(await roleIn({ ...ctx, user }, projectId))) {
    return notFoundError('Project not found')
  }
})
