import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

interface StoredMessage {
  id: string
  body: unknown
  attempts: number
  visibleAt: number
  leaseId: string | undefined
}

/**
 * In-memory Cloudflare Queues REST API: bulk push, pull (JSON bodies
 * base64-encoded, as documented) and ack / retry.
 */
export const startCloudflareServer = async ({ base64 = true } = {}) => {
  const queues = new Map<string, StoredMessage[]>()
  const calls: {
    path: string
    body: Record<string, unknown>
    auth: string | undefined
  }[] = []
  const failures = new Map<string, { status: number; body: string }>()

  const queueOf = (id: string) => {
    let queue = queues.get(id)
    if (!queue) {
      queue = []
      queues.set(id, queue)
    }
    return queue
  }

  const ok = (result: unknown) =>
    JSON.stringify({ success: true, errors: [], messages: [], result })

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = req.url ?? ''
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      calls.push({ path: url, body, auth: req.headers.authorization })
      const match =
        /^\/client\/v4\/accounts\/([^/]+)\/queues\/([^/]+)\/messages\/(batch|pull|ack)$/.exec(
          url
        )
      const failure = match
        ? failures.get(`${match[2]}/${match[3]}`)
        : undefined
      if (failure && match) {
        failures.delete(`${match[2]}/${match[3]}`)
        res.writeHead(failure.status, { 'content-type': 'application/json' })
        res.end(failure.body)
        return
      }
      if (!match) {
        res.writeHead(404)
        res.end()
        return
      }
      const [, , queueId, action] = match
      const queue = queueOf(queueId as string)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (action === 'batch') {
        for (const message of body.messages as {
          body: unknown
          delay_seconds?: number
        }[]) {
          queue.push({
            id: randomUUID(),
            body: message.body,
            attempts: 0,
            visibleAt: Date.now() + (message.delay_seconds ?? 0) * 1000,
            leaseId: undefined,
          })
        }
        res.end(ok({ metadata: { metrics: {} } }))
      } else if (action === 'pull') {
        const now = Date.now()
        const pulled = queue
          .filter((message) => message.visibleAt <= now)
          .slice(0, body.batch_size ?? 5)
        for (const message of pulled) {
          message.attempts += 1
          message.leaseId = randomUUID()
          message.visibleAt = now + (body.visibility_timeout_ms ?? 30_000)
        }
        res.end(
          ok({
            message_backlog_count: queue.length,
            messages: pulled.map((message) => {
              const json = JSON.stringify(message.body)
              return {
                id: message.id,
                body: base64 ? Buffer.from(json).toString('base64') : json,
                attempts: message.attempts,
                lease_id: message.leaseId,
                metadata: { 'CF-Content-Type': 'json' },
                timestamp_ms: now,
              }
            }),
          })
        )
      } else {
        const acks = (body.acks ?? []) as { lease_id: string }[]
        const retries = (body.retries ?? []) as {
          lease_id: string
          delay_seconds?: number
        }[]
        for (const { lease_id } of acks) {
          const index = queue.findIndex(
            (message) => message.leaseId === lease_id
          )
          if (index >= 0) queue.splice(index, 1)
        }
        for (const { lease_id, delay_seconds = 0 } of retries) {
          const message = queue.find((item) => item.leaseId === lease_id)
          if (message) message.visibleAt = Date.now() + delay_seconds * 1000
        }
        res.end(
          ok({
            ackCount: acks.length,
            retryCount: retries.length,
            warnings: {},
          })
        )
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`

  return {
    url,
    queue: queueOf,
    calls,
    /** The next call of this action (batch, pull, ack) on this queue fails. */
    failNext: (queueId: string, action: string, status: number, body: string) =>
      failures.set(`${queueId}/${action}`, { status, body }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
