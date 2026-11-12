import { authPlugin, type KeyPairSettings } from '@dotpress/auth'
import { createCache, type CacheStore } from '@dotpress/cache'
import { cachePlugin } from '@dotpress/cache/plugin'
import {
  createApp,
  createRouter,
  type HttpAdapter,
  type Logger,
} from '@dotpress/core'
import type { EventBus } from '@dotpress/events'
import { eventsPlugin } from '@dotpress/events/plugin'
import { openapiPlugin } from '@dotpress/openapi'
import { createAuthService } from './auth/auth.ts'
import type { Database } from './db/database.ts'
import { createLoaders } from './loaders.ts'
import { createProjectRepository } from './projects/repository.ts'
import { projectsRouter } from './projects/routes.ts'
import { createTaskRepository } from './tasks/repository.ts'
import { tasksRouter } from './tasks/routes.ts'
import { createUserRepository } from './users/repository.ts'
import { usersRouter } from './users/routes.ts'

export interface TasksAppOptions<TAdapter extends HttpAdapter> {
  adapter: TAdapter
  db: Database
  keys: KeyPairSettings
  /** Public URL of the API: the issuer of the tokens. */
  publicUrl: string
  cacheStore: CacheStore
  /** The event bus of `bus.ts`, or a fake bus in tests. */
  events: EventBus
  /** bcrypt cost: lower in the tests. Defaults to 12. */
  passwordHashRounds?: number
  logger?: Logger
}

/**
 * The app, on any adapter: Fastify in `server.ts`, the memory adapter of
 * `@dotpress/testing` in the tests.
 */
export const createTasksApp = <TAdapter extends HttpAdapter>(
  options: TasksAppOptions<TAdapter>
) => {
  const { adapter, db, logger } = options
  const users = createUserRepository(db)
  const projects = createProjectRepository(db)
  const tasks = createTaskRepository(db)
  const loaders = createLoaders(projects, users)

  const auth = createAuthService({
    db,
    users,
    keys: options.keys,
    issuer: options.publicUrl,
    passwordHashRounds: options.passwordHashRounds,
  })
  const cache = createCache({
    store: options.cacheStore,
    prefix: 'tasks-api',
    // A slow store counts as a failure: the request goes on without cache.
    storeTimeout: '200ms',
  })

  const health = createRouter()
  health.defineRoute({
    path: '/health',
    meta: { summary: 'Health check', tags: ['health'] },
    handler: () => {
      db.prepare('SELECT 1').get()
      return { status: 'ok' }
    },
  })

  return createApp({
    adapter,
    ...(logger && { logger }),
    routers: [
      health,
      usersRouter(auth, users),
      projectsRouter({ projects, tasks, users, loaders }),
      tasksRouter({ tasks, loaders }),
    ],
    plugins: [
      // ctx.user and ctx.auth; /auth/login, /refresh, /me, /logout.
      authPlugin(auth),
      // ctx.memo (per request) and ctx.cache.
      cachePlugin({ cache }),
      // ctx.events: emits with the request logger and request ID.
      eventsPlugin(options.events),
      // /openapi.json and /docs: the routes guarded by requireAuth are
      // marked as secured.
      openapiPlugin({
        info: {
          title: 'Tasks API',
          version: '1.0.0',
          description:
            'A team task manager built with Dotpress. Sign up with `POST /users`, log in with `POST /auth/login`, then use the access token with the Authorize button.',
        },
        tags: [
          { name: 'auth', description: 'Sessions' },
          { name: 'users', description: 'Accounts' },
          { name: 'projects', description: 'Projects, members and dashboards' },
          { name: 'tasks', description: 'Tasks of the projects' },
          { name: 'health', description: 'Monitoring' },
        ],
      }),
    ],
  })
}
