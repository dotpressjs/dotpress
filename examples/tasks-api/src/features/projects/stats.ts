import { defineCacheEntry, type Memo } from '@dotpress/cache'
import { z } from 'zod'
import type { AppServices } from '../../services/index.ts'
import { personOf, PersonView } from '../users/loaders.ts'

const Counts = z.object({
  todo: z.number(),
  doing: z.number(),
  done: z.number(),
})

export const StatsView = z
  .object({
    total: z.number(),
    byStatus: Counts,
    byAssignee: z.array(Counts.extend({ assignee: PersonView.nullable() })),
  })
  .meta({ id: 'ProjectStats' })

export type Stats = z.infer<typeof StatsView>

/** Tag of the cached values of a project: expired when its tasks change. */
export const projectTag = (projectId: string) => `project:${projectId}`

/**
 * The dashboard of a project, shared by its members and across instances.
 * Only the data is cached: who may read it is checked on every request.
 */
export const statsCache = defineCacheEntry({
  name: 'project-stats',
  key: (projectId: string) => projectId,
  schema: StatsView,
  ttl: '5m',
  tags: (projectId: string) => [projectTag(projectId)],
})

const empty = () => ({ todo: 0, doing: 0, done: 0 })

export const computeStats = async (
  { tasks, loaders }: AppServices,
  memo: Memo,
  projectId: string
): Promise<Stats> => {
  const rows = await tasks.countByAssigneeAndStatus(projectId)
  const byStatus = empty()
  const byAssignee = new Map<string | null, ReturnType<typeof empty>>()
  for (const { assignee_id, status, count } of rows) {
    byStatus[status] += count
    const counts = byAssignee.get(assignee_id) ?? empty()
    counts[status] += count
    byAssignee.set(assignee_id, counts)
  }
  return {
    total: byStatus.todo + byStatus.doing + byStatus.done,
    byStatus,
    // The names of the assignees in one query (batched memo), by name, and
    // the unassigned tasks last.
    byAssignee: (
      await Promise.all(
        [...byAssignee].map(async ([assigneeId, counts]) => ({
          assignee: await personOf(memo, loaders.user, assigneeId),
          ...counts,
        }))
      )
    ).sort((a, b) =>
      a.assignee && b.assignee
        ? a.assignee.name.localeCompare(b.assignee.name)
        : a.assignee
          ? -1
          : 1
    ),
  }
}
