import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'

interface PublishedMessage {
  data: string
  attributes: Record<string, string>
}

/**
 * In-memory Pub/Sub REST API (`topics.publish`), and the JSON Web Key Set
 * of a local issuer of push tokens.
 */
export const startPubSubServer = async () => {
  const topics = new Map<string, PublishedMessage[]>()
  const calls: { path: string; auth: string | undefined; bytes: number }[] = []
  const failures = new Map<string, { status: number; body: string }>()
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'key-1', alg: 'RS256' }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = req.url ?? ''
      if (url === '/certs') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ keys: [jwk] }))
        return
      }
      const raw = Buffer.concat(chunks)
      calls.push({
        path: url,
        auth: req.headers.authorization,
        bytes: raw.length,
      })
      const match = /^\/v1\/(projects\/[^/]+\/topics\/[^/:]+):publish$/.exec(
        url
      )
      if (!match || req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }
      const topic = match[1] as string
      const failure = failures.get(topic)
      if (failure) {
        failures.delete(topic)
        res.writeHead(failure.status, { 'content-type': 'application/json' })
        res.end(failure.body)
        return
      }
      const { messages } = JSON.parse(raw.toString('utf8')) as {
        messages: PublishedMessage[]
      }
      const stored = topics.get(topic) ?? []
      topics.set(topic, stored)
      const ids = messages.map((message) => {
        stored.push(message)
        return String(stored.length)
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ messageIds: ids }))
    })
  })
  // Never closes idle connections itself: undici could reuse a connection
  // as the server closes it ("fetch failed", seen on Node.js 22 in CI).
  server.keepAliveTimeout = 0
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url,
    certsUrl: `${url}/certs`,
    calls,
    /** Messages published to a topic. */
    published: (topic: string) => topics.get(topic) ?? [],
    /** Envelopes published to a topic, decoded. */
    envelopes: (topic: string) =>
      (topics.get(topic) ?? []).map((message) =>
        JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'))
      ),
    /** Forgets the failures that no request consumed. */
    reset: () => failures.clear(),
    /** The next publication to this topic fails. */
    failNext: (topic: string, status: number, body: string) =>
      failures.set(topic, { status, body }),
    /** A push token signed by the local issuer. */
    token: (
      claims: JWTPayload,
      { issuer = 'https://accounts.google.com' } = {}
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
