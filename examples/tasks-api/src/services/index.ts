import type { Auth } from '@dotpress/auth'
import type { Database } from '../db/database.ts'
import { roleMemo } from '../features/projects/access.ts'
import { createProjectRepository } from '../features/projects/repository.ts'
import { createTaskRepository } from '../features/tasks/repository.ts'
import { userMemo } from '../features/users/loaders.ts'
import { createUserRepository } from '../features/users/repository.ts'

// The services of the app are created by functions, not singletons: each
// entry point (http/server.ts, worker.ts, seed.ts) creates the ones it
// needs, once, and closes them on shutdown; each test creates its own,
// in memory.

/** The repositories and the memos, over one database connection. */
export const createRepositories = (db: Database) => {
  const users = createUserRepository(db)
  const projects = createProjectRepository(db)
  const tasks = createTaskRepository(db)
  return {
    db,
    users,
    projects,
    tasks,
    /** Memos of the requests (`ctx.memo(loaders.user, id)`). */
    loaders: { user: userMemo(users), role: roleMemo(projects) },
  }
}

export type Repositories = ReturnType<typeof createRepositories>

/** What the handlers find in `ctx.services` (see http/services-plugin.ts). */
export interface AppServices extends Repositories {
  /** The authentication service: password hashing. */
  auth: Auth
}
