import type { Server } from 'node:http'
import { createAdaptorServer } from '@hono/node-server'
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
  listen(port: number, host?: string): Promise<void>
  /**
   * Stops the HTTP server: waits for pending requests, and closes the
   * responses being streamed (their `req.signal` is aborted).
   */
  close(): Promise<void>
  /** HTTP server started by `listen()`, if any. */
  server(): Server | undefined
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
        // Streams never end by themselves: close them.
        void adapter.close()
      })
    },

    server: () => server,
  }
}
