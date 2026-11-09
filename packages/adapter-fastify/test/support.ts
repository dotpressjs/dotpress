import type { AddressInfo } from 'node:net'
import { createApp, type AppOptions } from '@dotpress/core'
import { createHttpTarget, type ConformanceTarget } from '@dotpress/testing'
import type { FastifyInstance } from 'fastify'
import { fastifyAdapter, type FastifyAdapter } from '../src/index.js'

/**
 * Starts an app on a random port and returns a target to send requests to.
 */
export const startApp = async <TApp extends FastifyInstance>(
  adapter: FastifyAdapter<TApp>,
  options: Omit<AppOptions, 'adapter'>
): Promise<ConformanceTarget & { adapter: FastifyAdapter<TApp> }> => {
  const app = await createApp({ ...options, adapter })
  await app.listen(0, '127.0.0.1')

  const { port } = adapter.server()!.address() as AddressInfo
  return {
    ...createHttpTarget(`http://127.0.0.1:${port}`, () => app.close()),
    adapter,
  }
}

export { fastifyAdapter }
