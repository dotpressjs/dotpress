import { requireAuth } from '@dotpress/auth'
import {
  conflictError,
  createRouter,
  forbiddenError,
  notFoundError,
} from '@dotpress/core'
import { z } from 'zod'
import { requireMember, roleIn } from './access.ts'
import { computeStats, statsCache, StatsView } from './stats.ts'

const Role = z.enum(['owner', 'member'])

const ProjectView = z
  .object({
    id: z.uuid(),
    name: z.string(),
    ownerId: z.uuid(),
    role: Role,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Project' })

const MemberView = z
  .object({
    userId: z.uuid(),
    name: z.string(),
    role: Role,
    addedAt: z.iso.datetime(),
  })
  .meta({ id: 'Member' })

const PROJECT_NOT_FOUND = 'Project not found'

/**
 * The routes of the projects: a plain module. The handlers find the
 * services of the app in ctx.services.
 */
export const projectsRouter = createRouter()

// /projects: every route requires a user, and ctx.user is typed.
const group = projectsRouter.createGroup('/projects', [requireAuth])

group.defineRoute({
  method: 'post',
  path: '/',
  status: 201,
  schema: (z) => ({
    body: z.object({ name: z.string().trim().min(1).max(100) }),
    response: ProjectView,
  }),
  meta: { summary: 'Create a project', tags: ['projects'] },
  handler: async ({ req, user, services }) => {
    const project = await services.projects.create(req.body.name, user.id)
    return { ...project, role: 'owner' as const }
  },
})

group.defineRoute({
  path: '/',
  schema: (z) => ({ response: z.array(ProjectView) }),
  meta: { summary: 'List my projects', tags: ['projects'] },
  handler: ({ user, services }) => services.projects.listForUser(user.id),
})

// /projects/:projectId: a nested group. It inherits the prefix and
// requireAuth, adds requireMember (404 for non-members), and types
// req.params.projectId in its routes.
const project = group.createGroup('/:projectId', [requireMember])

project.defineRoute({
  path: '/',
  schema: (z) => ({
    response: ProjectView.extend({ members: z.array(MemberView) }),
  }),
  meta: {
    summary: 'Get a project and its members',
    tags: ['projects'],
    responses: { 404: PROJECT_NOT_FOUND },
  },
  handler: async (ctx) => {
    const { projectId } = ctx.req.params
    // Memoized by requireMember: no query.
    const role = (await roleIn(ctx, projectId))!
    const { projects } = ctx.services
    const found = await projects.findById(projectId)
    if (!found) return notFoundError(PROJECT_NOT_FOUND)
    return { ...found, role, members: await projects.listMembers(projectId) }
  },
})

project.defineRoute({
  method: 'post',
  path: '/members',
  status: 201,
  schema: (z) => ({
    body: z.object({ email: z.email() }),
    response: MemberView,
  }),
  meta: {
    summary: 'Add a member (owner only)',
    description: 'The member must have an account.',
    tags: ['projects'],
    responses: {
      403: 'Only the owner adds members',
      404: 'Project or account not found',
      409: 'Already a member',
    },
  },
  handler: async (ctx) => {
    const { projectId } = ctx.req.params
    if ((await roleIn(ctx, projectId)) !== 'owner') {
      return forbiddenError('Only the owner adds members')
    }

    const { users, projects } = ctx.services
    const member = await users.findByEmail(ctx.req.body.email)
    if (!member) return notFoundError('No account with this email address')
    if (await projects.findRole(projectId, member.id)) {
      return conflictError('Already a member')
    }
    await projects.addMember(projectId, member.id)
    return (await projects.listMembers(projectId)).find(
      (item) => item.userId === member.id
    )!
  },
})

project.defineRoute({
  path: '/stats',
  schema: () => ({ response: StatsView }),
  meta: {
    summary: 'Dashboard of a project',
    description:
      'Tasks by status and by assignee. Cached for 5 minutes, expired when a task changes.',
    tags: ['projects'],
    responses: { 404: PROJECT_NOT_FOUND },
  },
  // requireMember has run: the access is checked on every request, and
  // only the data is cached.
  handler: ({ req, cache, memo, services }) =>
    cache.getOrSet(statsCache, req.params.projectId, () =>
      computeStats(services, memo, req.params.projectId)
    ),
})
