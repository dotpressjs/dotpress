import { defineListener } from '@dotpress/events'
import type { Mailer } from '@dotpress/mailer'
import { get, run } from '../../db/database.ts'
import type { Repositories } from '../../services/index.ts'
import { taskAssigned, taskCompleted } from '../tasks/events.ts'
import { taskAssignedMail, taskCompletedMail } from './mails.ts'

/**
 * The listeners of the task events: they email the people concerned. They
 * run in the worker (with Redis), or in the API process (without): both
 * create them with their own services.
 */
export const createNotifications = ({
  repositories: { db, users, projects, tasks },
  mailer,
}: {
  repositories: Repositories
  mailer: Mailer
}) => {
  /**
   * Sends once per message: queues deliver a message at least once, and a
   * retry after a timeout must not send a second email. A crash between
   * the email and the insert can still send one twice, never lose one.
   */
  const once = async (messageId: string, send: () => Promise<unknown>) => {
    if (get(db, 'SELECT 1 FROM handled_messages WHERE id = ?', messageId)) {
      return
    }
    await send()
    run(
      db,
      'INSERT INTO handled_messages (id, handled_at) VALUES (?, ?)',
      messageId,
      new Date().toISOString()
    )
  }

  const notifyAssignee = defineListener(taskAssigned, {
    name: 'notify-assignee',
    handle: async ({ payload, id, logger }) => {
      const [task, assignee, actor] = await Promise.all([
        tasks.findById(payload.taskId),
        users.findById(payload.assigneeId),
        users.findById(payload.assignedBy),
      ])
      // Reassigned or deleted since the event: nothing to say any more.
      if (!task || !assignee || !actor || task.assigneeId !== assignee.id) {
        return
      }
      const project = await projects.findById(task.projectId)
      await once(id, () =>
        mailer.withContext({ logger }).send(taskAssignedMail, {
          to: { name: assignee.name, address: assignee.email },
          locale: assignee.locale,
          data: {
            recipientName: assignee.name,
            actorName: actor.name,
            taskTitle: task.title,
            projectName: project?.name ?? '',
          },
        })
      )
    },
  })

  const notifyCreator = defineListener(taskCompleted, {
    name: 'notify-creator',
    handle: async ({ payload, id, logger }) => {
      const task = await tasks.findById(payload.taskId)
      // Reopened since the event, or completed by its creator.
      if (
        !task ||
        task.status !== 'done' ||
        task.createdBy === payload.completedBy
      ) {
        return
      }
      const [creator, actor, project] = await Promise.all([
        users.findById(task.createdBy),
        users.findById(payload.completedBy),
        projects.findById(task.projectId),
      ])
      if (!creator || !actor) return
      await once(id, () =>
        mailer.withContext({ logger }).send(taskCompletedMail, {
          to: { name: creator.name, address: creator.email },
          locale: creator.locale,
          data: {
            recipientName: creator.name,
            actorName: actor.name,
            taskTitle: task.title,
            projectName: project?.name ?? '',
          },
        })
      )
    },
  })

  return [notifyAssignee, notifyCreator]
}
