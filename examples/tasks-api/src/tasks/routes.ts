import { requireAuth } from '@dotpress/auth'
import type { Memo } from '@dotpress/cache'
import { createRouter, notFoundError, unprocessableError } from '@dotpress/core'
import { z } from 'zod'
import {
  personOf,
  PersonView,
  requireMember,
  roleIn,
  type Loaders,
} from '../loaders.ts'
import { projectTag } from '../projects/stats.ts'
import { taskAssigned, taskCompleted } from './events.ts'
import type { Task, TaskRepository } from './repository.ts'

const Status = z.enum(['todo', 'doing', 'done'])

const TaskView = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    title: z.string(),
    status: Status,
    assignee: PersonView.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Task' })

const Title = z.string().trim().min(1).max(200)

const TASK_NOT_FOUND = 'Task not found'
const NOT_A_MEMBER = 'The assignee is not a member of the project'

export const tasksRouter = (deps: {
  tasks: TaskRepository
  loaders: Loaders
}) => {
  const { tasks, loaders } = deps
  const router = createRouter()

  /** A task as the API returns it, with the name of its assignee. */
  const toView = async (memo: Memo, task: Task) => ({
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    assignee: await personOf(memo, loaders, task.assigneeId),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  })

  /** An assignee must be a member of the project (memoized check). */
  const isMember = async (memo: Memo, projectId: string, userId: string) =>
    (await memo(loaders.role, projectId, userId)) !== undefined

  // /projects/:projectId/tasks: the tasks of a project, for its members.
  const projectTasks = router.createGroup('/projects/:projectId/tasks', [
    requireAuth,
    requireMember(loaders),
  ])

  projectTasks.defineRoute({
    method: 'post',
    path: '/',
    status: 201,
    schema: (z) => ({
      body: z.object({ title: Title, assigneeId: z.uuid().optional() }),
      response: TaskView,
    }),
    meta: {
      summary: 'Create a task',
      tags: ['tasks'],
      responses: { 404: 'Project not found', 422: NOT_A_MEMBER },
    },
    // ctx.events: eventsPlugin, with the request ID in the metadata.
    handler: async ({ req, memo, user, cache, events }) => {
      const { projectId } = req.params
      const { title, assigneeId } = req.body
      if (assigneeId && !(await isMember(memo, projectId, assigneeId))) {
        return unprocessableError(NOT_A_MEMBER)
      }

      const task = await tasks.create({
        projectId,
        title,
        assigneeId: assigneeId ?? null,
        createdBy: user.id,
      })
      await cache.invalidateTags([projectTag(projectId)])
      // After the write: the event describes something that happened. The
      // response does not wait for the email, sent by a listener.
      if (assigneeId && assigneeId !== user.id) {
        await events.emit(taskAssigned, {
          taskId: task.id,
          assigneeId,
          assignedBy: user.id,
        })
      }
      return toView(memo, task)
    },
  })

  projectTasks.defineRoute({
    path: '/',
    schema: (z) => ({
      query: z.object({
        status: Status.optional(),
        assignee: z.uuid().optional(),
      }),
      response: z.array(TaskView),
    }),
    meta: {
      summary: 'List the tasks of a project',
      tags: ['tasks'],
      responses: { 404: 'Project not found' },
    },
    handler: async ({ req, memo }) => {
      const list = await tasks.listByProject(req.params.projectId, {
        status: req.query.status,
        assigneeId: req.query.assignee,
      })
      // The assignees of every task in one query: the memo batches them.
      return Promise.all(list.map((task) => toView(memo, task)))
    },
  })

  // /tasks/:id: the project is not in the path, so the membership is
  // checked in the handlers, once the task is loaded.
  const taskGroup = router.createGroup('/tasks', [requireAuth])

  taskGroup.defineRoute({
    path: '/:id',
    schema: () => ({ response: TaskView }),
    meta: {
      summary: 'Get a task',
      tags: ['tasks'],
      responses: { 404: TASK_NOT_FOUND },
    },
    handler: async (ctx) => {
      const task = await tasks.findById(ctx.req.params.id)
      if (!task || !(await roleIn(ctx, loaders, task.projectId))) {
        return notFoundError(TASK_NOT_FOUND)
      }
      return toView(ctx.memo, task)
    },
  })

  taskGroup.defineRoute({
    method: 'patch',
    path: '/:id',
    schema: (z) => ({
      body: z.object({
        title: Title.optional(),
        status: Status.optional(),
        // null: unassigned.
        assigneeId: z.uuid().nullable().optional(),
      }),
      response: TaskView,
    }),
    meta: {
      summary: 'Update a task: title, status, assignee',
      tags: ['tasks'],
      responses: { 404: TASK_NOT_FOUND, 422: NOT_A_MEMBER },
    },
    handler: async (ctx) => {
      const { req, memo } = ctx
      const task = await tasks.findById(req.params.id)
      if (!task || !(await roleIn(ctx, loaders, task.projectId))) {
        return notFoundError(TASK_NOT_FOUND)
      }
      const { assigneeId } = req.body
      if (assigneeId && !(await isMember(memo, task.projectId, assigneeId))) {
        return unprocessableError(NOT_A_MEMBER)
      }

      const updated = (await tasks.update(task.id, req.body))!
      await ctx.cache.invalidateTags([projectTag(task.projectId)])

      const { user, events } = ctx
      if (
        updated.assigneeId &&
        updated.assigneeId !== task.assigneeId &&
        updated.assigneeId !== user.id
      ) {
        await events.emit(taskAssigned, {
          taskId: task.id,
          assigneeId: updated.assigneeId,
          assignedBy: user.id,
        })
      }
      if (updated.status === 'done' && task.status !== 'done') {
        await events.emit(taskCompleted, {
          taskId: task.id,
          completedBy: user.id,
        })
      }
      return toView(memo, updated)
    },
  })

  return router
}
