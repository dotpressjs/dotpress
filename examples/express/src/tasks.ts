export interface Task {
  id: string
  title: string
  done: boolean
  createdAt: string
}

export type TaskChanges = Partial<Pick<Task, 'title' | 'done'>>

export type TaskStore = ReturnType<typeof createTaskStore>

/**
 * In-memory task store. Replace it with your database: the routes only
 * depend on these methods.
 */
export const createTaskStore = () => {
  const tasks = new Map<string, Task>()

  return {
    async list(filter: { done?: boolean } = {}): Promise<Task[]> {
      return [...tasks.values()].filter(
        (task) => filter.done === undefined || task.done === filter.done
      )
    },

    async get(id: string): Promise<Task | undefined> {
      return tasks.get(id)
    },

    async findByTitle(title: string): Promise<Task | undefined> {
      const key = title.toLowerCase()
      return [...tasks.values()].find(
        (task) => task.title.toLowerCase() === key
      )
    },

    async create(title: string): Promise<Task> {
      const task: Task = {
        id: crypto.randomUUID(),
        title,
        done: false,
        createdAt: new Date().toISOString(),
      }
      tasks.set(task.id, task)
      return task
    },

    async update(id: string, changes: TaskChanges): Promise<Task | undefined> {
      const task = tasks.get(id)
      if (!task) return undefined

      const updated: Task = {
        ...task,
        title: changes.title ?? task.title,
        done: changes.done ?? task.done,
      }
      tasks.set(id, updated)
      return updated
    },

    async remove(id: string): Promise<boolean> {
      return tasks.delete(id)
    },
  }
}
