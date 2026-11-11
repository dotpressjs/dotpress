import { createApp, type HttpAdapter, type Logger } from '@dotpress/core'
import { openapiPlugin } from '@dotpress/openapi'
import { tasksRouter } from './routes.ts'
import { createTaskStore, type TaskStore } from './tasks.ts'

export interface TasksAppOptions<TAdapter extends HttpAdapter> {
  adapter: TAdapter
  store?: TaskStore
  logger?: Logger
}

/**
 * Creates the app on any adapter: Express in `server.ts`, the memory
 * adapter of `@dotpress/testing` in the tests.
 */
export const createTasksApp = <TAdapter extends HttpAdapter>({
  adapter,
  store = createTaskStore(),
  logger,
}: TasksAppOptions<TAdapter>) =>
  createApp({
    adapter,
    ...(logger && { logger }),
    routers: [tasksRouter(store)],
    plugins: [
      // GET /openapi.json: the OpenAPI document, GET /docs: the Scalar page
      openapiPlugin({
        info: { title: 'Tasks API', version: '1.0.0' },
        tags: [{ name: 'tasks', description: 'Tasks to do' }],
      }),
    ],
  })
