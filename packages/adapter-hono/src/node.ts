import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { createAdaptorServer } from '@hono/node-server'
import type { ListenAddress } from '@dotpress/core'
import type { Hono } from 'hono'
import {
  honoAdapter as createHonoAdapter,
  type HonoAdapter,
  type HonoAdapterOptions,
  type HonoApplication,
} from './index.js'

export * from './index.js'

export interface NodeHonoAdapter<
  TApp extends HonoApplication = Hono,
> extends HonoAdapter<TApp> {
  /** Starts an HTTP server (`@hono/node-server`). */
  listen(port: number, host?: string): Promise<ListenAddress>
  /**
   * Stops the HTTP server: waits for pending requests, and closes the
   * responses being streamed (their `req.signal` is aborted).
   */
  close(): Promise<void>
  /** HTTP server started by `listen()`, if any. */
  server(): Server | undefined
}

/** Address of a listening Node.js server. */
const addressOf = (server: Server): ListenAddress => {
  const address = server.address() as AddressInfo
  return { port: address.port, host: address.address }
}

/**
 * Lets `close()` complete as soon as the pending requests are served, and
 * returns the function to call on close. Before Node.js 26, `server.close()`
 * waits for the connections that have sent nothing yet (a browser
 * preconnect…) until `headersTimeout`; and, whatever the version, the
 * connections of the pending requests stay open once served, until
 * `keepAliveTimeout`.
 */
const trackConnections = (server: Server) => {
  const sockets = new Set<Socket>()
  let closing = false
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on(
    'request',
    (_request: IncomingMessage, response: ServerResponse) => {
      response.once('finish', () => {
        if (closing) server.closeIdleConnections()
      })
    }
  )
  return () => {
    closing = true
    for (const socket of sockets) {
      if (socket.bytesRead === 0) socket.destroy()
    }
  }
}

/**
 * Creates the Hono adapter for Node.js: the adapter of
 * `@dotpress/adapter-hono`, with an HTTP server (`@hono/node-server`).
 *
 * @example
 * const app = await createApp({ adapter: honoAdapter() })
 * await app.listen(3000)
 */
export function honoAdapter(options?: HonoAdapterOptions<Hono>): NodeHonoAdapter
export function honoAdapter<TApp extends HonoApplication>(
  options: HonoAdapterOptions<TApp> & { app: TApp }
): NodeHonoAdapter<TApp>
export function honoAdapter<TApp extends HonoApplication>(
  options: HonoAdapterOptions<TApp> = {}
): NodeHonoAdapter<TApp> {
  const adapter = createHonoAdapter(
    options as HonoAdapterOptions<TApp> & { app: TApp }
  )
  let server: Server | undefined
  let closeConnections = () => {}

  return {
    ...adapter,

    listen: async (port: number, host?: string) => {
      if (server) throw new Error('The Hono adapter is already listening.')

      const created = createAdaptorServer({ fetch: adapter.fetch }) as Server
      await new Promise<void>((resolve, reject) => {
        created.once('error', reject)
        created.listen(port, host, () => {
          created.off('error', reject)
          resolve()
        })
      })
      server = created
      closeConnections = trackConnections(created)
      return addressOf(created)
    },

    close: async () => {
      const current = server
      server = undefined
      if (!current) {
        await adapter.close()
        return
      }

      await new Promise<void>((resolve, reject) => {
        // Also closes the idle connections.
        current.close((error) => (error ? reject(error) : resolve()))
        closeConnections()
        // Streams never end by themselves: close them.
        void adapter.close()
      })
    },

    server: () => server,
  }
}
