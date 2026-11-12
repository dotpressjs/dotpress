import { defineEvent } from '@dotpress/events'
import { z } from 'zod'

// Facts about the tasks. The payloads carry identifiers, not data: queues
// store the messages, and listeners load what they need from the database.

/** A task was assigned to someone else than the user who assigned it. */
export const taskAssigned = defineEvent({
  name: 'task.assigned',
  schema: z.object({
    taskId: z.uuid(),
    assigneeId: z.uuid(),
    assignedBy: z.uuid(),
  }),
})

/** A task moved to the `done` status. */
export const taskCompleted = defineEvent({
  name: 'task.completed',
  schema: z.object({ taskId: z.uuid(), completedBy: z.uuid() }),
})
