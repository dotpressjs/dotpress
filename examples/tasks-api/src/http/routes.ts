import { createRouter } from '@dotpress/core'
import { projectsRouter } from '../features/projects/routes.ts'
import { tasksRouter } from '../features/tasks/routes.ts'
import { usersRouter } from '../features/users/routes.ts'

// The routes of the app: each feature owns its router, with its groups and
// middlewares. The README shows the resulting URL map.

const healthRouter = createRouter()
healthRouter.defineRoute({
  path: '/health',
  meta: { summary: 'Health check', tags: ['health'] },
  handler: ({ services }) => {
    services.db.prepare('SELECT 1').get()
    return { status: 'ok' }
  },
})

export const routers = [healthRouter, usersRouter, projectsRouter, tasksRouter]
