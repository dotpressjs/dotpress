import { randomUUID } from 'node:crypto'
import { all, get, run, transaction, type Database } from '../db/database.ts'

export type Role = 'owner' | 'member'

export interface Project {
  id: string
  name: string
  ownerId: string
  createdAt: string
}

export interface Member {
  userId: string
  name: string
  role: Role
  addedAt: string
}

interface ProjectRow {
  id: string
  name: string
  owner_id: string
  created_at: string
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  ownerId: row.owner_id,
  createdAt: row.created_at,
})

export const createProjectRepository = (db: Database) => ({
  /** Creates a project, with its owner as first member. */
  create: async (name: string, ownerId: string): Promise<Project> => {
    const row: ProjectRow = {
      id: randomUUID(),
      name,
      owner_id: ownerId,
      created_at: new Date().toISOString(),
    }
    transaction(db, () => {
      run(
        db,
        'INSERT INTO projects (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)',
        row.id,
        row.name,
        row.owner_id,
        row.created_at
      )
      run(
        db,
        "INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)",
        row.id,
        ownerId,
        row.created_at
      )
    })
    return toProject(row)
  },

  findById: async (id: string) => {
    const row = get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', id)
    return row && toProject(row)
  },

  /** The projects of a user, with their role. */
  listForUser: async (userId: string) =>
    all<ProjectRow & { role: Role }>(
      db,
      `SELECT projects.*, project_members.role FROM projects
       JOIN project_members ON project_members.project_id = projects.id
       WHERE project_members.user_id = ? ORDER BY projects.created_at`,
      userId
    ).map((row) => ({ ...toProject(row), role: row.role })),

  /** The role of a user in a project, or undefined for a non-member. */
  findRole: async (projectId: string, userId: string) =>
    get<{ role: Role }>(
      db,
      'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      userId
    )?.role,

  listMembers: async (projectId: string) =>
    all<{ user_id: string; name: string; role: Role; added_at: string }>(
      db,
      `SELECT project_members.user_id, users.name, project_members.role, project_members.added_at
       FROM project_members JOIN users ON users.id = project_members.user_id
       WHERE project_members.project_id = ? ORDER BY project_members.added_at`,
      projectId
    ).map((row): Member => ({
      userId: row.user_id,
      name: row.name,
      role: row.role,
      addedAt: row.added_at,
    })),

  addMember: async (projectId: string, userId: string) => {
    run(
      db,
      "INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'member', ?)",
      projectId,
      userId,
      new Date().toISOString()
    )
  },
})

export type ProjectRepository = ReturnType<typeof createProjectRepository>
