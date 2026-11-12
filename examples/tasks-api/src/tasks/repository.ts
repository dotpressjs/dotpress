import { randomUUID } from 'node:crypto'
import { all, get, run, type Database } from '../db/database.ts'

export type Status = 'todo' | 'doing' | 'done'
export const STATUSES: readonly Status[] = ['todo', 'doing', 'done']

export interface Task {
  id: string
  projectId: string
  title: string
  status: Status
  assigneeId: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

interface TaskRow {
  id: string
  project_id: string
  title: string
  status: Status
  assignee_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

const toTask = (row: TaskRow): Task => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  status: row.status,
  assigneeId: row.assignee_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const createTaskRepository = (db: Database) => ({
  create: async (input: {
    projectId: string
    title: string
    assigneeId: string | null
    createdBy: string
  }): Promise<Task> => {
    const now = new Date().toISOString()
    const row: TaskRow = {
      id: randomUUID(),
      project_id: input.projectId,
      title: input.title,
      status: 'todo',
      assignee_id: input.assigneeId,
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    }
    run(
      db,
      'INSERT INTO tasks (id, project_id, title, status, assignee_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      row.id,
      row.project_id,
      row.title,
      row.status,
      row.assignee_id,
      row.created_by,
      row.created_at,
      row.updated_at
    )
    return toTask(row)
  },

  findById: async (id: string) => {
    const row = get<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ?', id)
    return row && toTask(row)
  },

  /** The tasks of a project, optionally filtered. */
  listByProject: async (
    projectId: string,
    filters: {
      status?: Status | undefined
      assigneeId?: string | undefined
    } = {}
  ) => {
    const conditions = ['project_id = ?']
    const params: string[] = [projectId]
    if (filters.status) {
      conditions.push('status = ?')
      params.push(filters.status)
    }
    if (filters.assigneeId) {
      conditions.push('assignee_id = ?')
      params.push(filters.assigneeId)
    }
    return all<TaskRow>(
      db,
      `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at, id`,
      ...params
    ).map(toTask)
  },

  update: async (
    id: string,
    patch: Partial<Pick<Task, 'title' | 'status' | 'assigneeId'>>
  ) => {
    const current = get<TaskRow>(db, 'SELECT * FROM tasks WHERE id = ?', id)
    if (!current) return undefined
    const row: TaskRow = {
      ...current,
      title: patch.title ?? current.title,
      status: patch.status ?? current.status,
      assignee_id:
        patch.assigneeId === undefined ? current.assignee_id : patch.assigneeId,
      updated_at: new Date().toISOString(),
    }
    run(
      db,
      'UPDATE tasks SET title = ?, status = ?, assignee_id = ?, updated_at = ? WHERE id = ?',
      row.title,
      row.status,
      row.assignee_id,
      row.updated_at,
      id
    )
    return toTask(row)
  },

  /** Number of tasks by assignee and status: the data of the dashboard. */
  countByAssigneeAndStatus: async (projectId: string) =>
    all<{ assignee_id: string | null; status: Status; count: number }>(
      db,
      `SELECT assignee_id, status, COUNT(*) AS count FROM tasks
       WHERE project_id = ? GROUP BY assignee_id, status`,
      projectId
    ),
})

export type TaskRepository = ReturnType<typeof createTaskRepository>
