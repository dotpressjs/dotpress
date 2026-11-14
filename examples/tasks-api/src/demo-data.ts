import { generatePasswordHash } from '@dotpress/auth'
import type { Database } from './db/database.ts'
import { createProjectRepository } from './features/projects/repository.ts'
import { createTaskRepository } from './features/tasks/repository.ts'
import { createUserRepository } from './features/users/repository.ts'

/** Password of the demo accounts: for development only. */
export const DEMO_PASSWORD = 'correct horse battery staple'

/**
 * Demo data: Alice (English) owns the "Website launch" project, Bob
 * (French) is a member. Does nothing when Alice already exists.
 */
export const seedDemo = async (db: Database, passwordHashRounds = 12) => {
  const users = createUserRepository(db)
  if (await users.findByEmail('alice@example.com')) return { created: false }

  const passwordHash = await generatePasswordHash(DEMO_PASSWORD, {
    rounds: passwordHashRounds,
  })
  const alice = await users.create({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash,
    locale: 'en',
  })
  const bob = await users.create({
    email: 'bob@example.com',
    name: 'Bob',
    passwordHash,
    locale: 'fr',
  })

  const projects = createProjectRepository(db)
  const project = await projects.create('Website launch', alice.id)
  await projects.addMember(project.id, bob.id)

  const tasks = createTaskRepository(db)
  const task = (title: string, assigneeId: string | null) =>
    tasks.create({
      projectId: project.id,
      title,
      assigneeId,
      createdBy: alice.id,
    })
  await task('Write the homepage copy', bob.id).then((created) =>
    tasks.update(created.id, { status: 'doing' })
  )
  await task('Choose the hosting', alice.id).then((created) =>
    tasks.update(created.id, { status: 'done' })
  )
  await task('Set up the analytics', null)

  return { created: true, projectId: project.id }
}
