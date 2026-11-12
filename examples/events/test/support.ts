import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface WarehouseRequest {
  headers: IncomingHttpHeaders
  body: unknown
}

/**
 * A fake warehouse service, over HTTP: it answers the given statuses in
 * order (then 200), and records the requests.
 */
export const startWarehouse = async (statuses: number[] = []) => {
  const requests: WarehouseRequest[] = []
  const waiting: (() => void)[] = []

  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ headers: req.headers, body: JSON.parse(body) })
    for (const resolve of waiting.splice(0)) resolve()
    res.statusCode = statuses.shift() ?? 200
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/orders`,
    requests,
    /**
     * Resolves when the warehouse has received `count` requests; rejects
     * after `timeout` milliseconds, so that the test cleans up.
     */
    received: async (count: number, timeout = 10_000) => {
      const deadline = AbortSignal.timeout(timeout)
      while (requests.length < count) {
        await new Promise<void>((resolve, reject) => {
          waiting.push(resolve)
          deadline.addEventListener('abort', () =>
            reject(
              new Error(
                `The warehouse received ${requests.length} of ${count} requests.`
              )
            )
          )
        })
      }
    },
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}
