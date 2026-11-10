import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Request received by the local server. */
export interface ReceivedRequest {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: string
  /** Raw body (binary parts of multipart bodies). */
  raw: Buffer
}

export interface Reply {
  status: number
  headers?: Record<string, string>
  body?: string
}

/** Local HTTP server answering with `reply`, recording the requests. */
export const startHttpServer = async (
  reply: (request: ReceivedRequest) => Reply
) => {
  const requests: ReceivedRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const request = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw.toString('utf8'),
        raw,
      }
      requests.push(request)
      const { status, headers = {}, body = '' } = reply(request)
      res.writeHead(status, headers)
      res.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
