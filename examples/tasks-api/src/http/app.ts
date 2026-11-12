import { authPlugin, type KeyPairSettings } from '@dotpress/auth'
import { createCache, type CacheStore } from '@dotpress/cache'
import { cachePlugin } from '@dotpress/cache/plugin'
import { createApp, type HttpAdapter, type Logger } from '@dotpress/core'
import type { EventBus } from '@dotpress/events'
import { eventsPlugin } from '@dotpress/events/plugin'
import { openapiPlugin } from '@dotpress/openapi'
import { createAuthService } from '../features/auth/auth.ts'
import type { Repositories } from '../services/index.ts'
import { routers } from './routes.ts'
import { servicesPlugin } from './services-plugin.ts'

export interface TasksAppOptions<TAdapter extends HttpAdapter> {
  adapter: TAdapter
  /** The repositories of `createRepositories()`, over one database. */
  repositories: Repositories
  keys: KeyPairSettings
  /** Public URL of the API: the issuer of the tokens. */
  publicUrl: string
  cacheStore: CacheStore
  /** The event bus of `services/bus.ts`, or a fake bus in tests. */
  events: EventBus
  /** bcrypt cost: lower in the tests. Defaults to 12. */
  passwordHashRounds?: number
  logger?: Logger
}

/**
 * The HTTP app, on any adapter: Fastify in `server.ts`, the memory adapter
 * of `@dotpress/testing` in the tests. Its services come from the caller:
 * the entry point in production, each test in the tests.
 */
export const createTasksApp = <TAdapter extends HttpAdapter>(
  options: TasksAppOptions<TAdapter>
) => {
  const { adapter, repositories, logger } = options
  const auth = createAuthService({
    db: repositories.db,
    users: repositories.users,
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

  return createApp({
    adapter,
    ...(logger && { logger }),
    routers,
    plugins: [
      // ctx.services: the repositories, the memos and auth of the app.
      servicesPlugin({ ...repositories, auth }),
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
