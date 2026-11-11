import {
  conflictError,
  createRouter,
  empty,
  notFoundError,
} from '@dotpress/core'
import { z } from 'zod'
import type { TaskStore } from './tasks.ts'

// A schema with an identifier is declared once in the OpenAPI document
// (components/schemas), and referenced by the routes.
const Task = z
  .object({
    id: z.uuid(),
    title: z.string(),
    done: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Task', description: 'A task to do' })

const Title = z.string().trim().min(1).max(200)

const TASK_NOT_FOUND = 'Task not found'
const DUPLICATE_TITLE = 'A task with this title already exists'

/**
 * Routes of the tasks. The store is a parameter: tests and environments
 * give their own, without a dependency injection container.
 */
export const tasksRouter = (store: TaskStore) => {
  const router = createRouter()
  const tasks = router.createGroup('/tasks')

  tasks.defineRoute({
    path: '/',
    schema: (z) => ({
      query: z.object({ done: z.stringbool().optional() }),
      response: z.array(Task),
    }),
    meta: { summary: 'List the tasks', tags: ['tasks'] },
    // req.query: { done?: boolean }
    handler: ({ req }) => store.list({ done: req.query.done }),
  })

  tasks.defineRoute({
    method: 'post',
    path: '/',
    status: 201,
    schema: (z) => ({
      body: z.object({ title: Title }),
      response: Task,
    }),
    meta: {
      summary: 'Create a task',
      tags: ['tasks'],
      responses: { 409: DUPLICATE_TITLE },
    },
    handler: async ({ req }) => {
      // Errors are returned, not thrown: they are part of the handler type.
      if (await store.findByTitle(req.body.title)) {
        return conflictError(DUPLICATE_TITLE)
      }
      return store.create(req.body.title)
    },
  })

  tasks.defineRoute({
    path: '/:id',
    schema: () => ({ response: Task }),
    meta: {
      summary: 'Get a task',
      tags: ['tasks'],
      responses: { 404: TASK_NOT_FOUND },
    },
    // req.params: { id: string }, from the path
    handler: async ({ req }) =>
      (await store.get(req.params.id)) ?? notFoundError(TASK_NOT_FOUND),
  })

  tasks.defineRoute({
    method: 'patch',
    path: '/:id',
    schema: (z) => ({
      body: z.object({ title: Title.optional(), done: z.boolean().optional() }),
      response: Task,
    }),
    meta: {
      summary: 'Update a task',
      tags: ['tasks'],
      responses: { 404: TASK_NOT_FOUND, 409: DUPLICATE_TITLE },
    },
    handler: async ({ req }) => {
      const { title } = req.body
      if (title !== undefined) {
        const existing = await store.findByTitle(title)
        if (existing && existing.id !== req.params.id) {
          return conflictError(DUPLICATE_TITLE)
        }
      }
      return (
        (await store.update(req.params.id, req.body)) ??
        notFoundError(TASK_NOT_FOUND)
      )
    },
  })

  tasks.defineRoute({
    method: 'delete',
    path: '/:id',
    status: 204,
    meta: {
      summary: 'Delete a task',
      tags: ['tasks'],
      responses: { 404: TASK_NOT_FOUND },
    },
    handler: async ({ req }) =>
      (await store.remove(req.params.id))
        ? empty()
        : notFoundError(TASK_NOT_FOUND),
  })

  return router
}
