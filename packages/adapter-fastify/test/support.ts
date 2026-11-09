import type { AddressInfo } from 'node:net'
import { createApp, type AppOptions } from '@dotpress/core'
import {
  createHttpTarget,
  createLambdaTarget,
  type ConformanceTarget,
  type LambdaEventFormat,
} from '@dotpress/testing'
import type { FastifyInstance } from 'fastify'
import { fastifyAdapter, type FastifyAdapter } from '../src/index.js'
import { createLambdaHandler } from '../src/lambda.js'

type AppSetup = Omit<AppOptions, 'adapter'>

/**
 * Starts an app on a random port and returns a target to send requests to.
 */
export const startApp = async <TApp extends FastifyInstance>(
  adapter: FastifyAdapter<TApp>,
  options: AppSetup
): Promise<ConformanceTarget & { adapter: FastifyAdapter<TApp> }> => {
  const app = await createApp({ ...options, adapter })
  await app.listen(0, '127.0.0.1')

  const { port } = adapter.server()!.address() as AddressInfo
  return {
    ...createHttpTarget(`http://127.0.0.1:${port}`, () => app.close()),
    adapter,
  }
}

/**
 * Creates a Lambda handler for the app, and returns a target sending
 * simulated events of the given format.
 */
export const startLambda = (
  format: LambdaEventFormat,
  options: AppSetup
): ConformanceTarget => {
  let app: { close(): Promise<void> } | undefined
  const handler = createLambdaHandler(async () => {
    const created = await createApp({ ...options, adapter: fastifyAdapter() })
    app = created
    return created
  })
  return createLambdaTarget(handler, {
    format,
    close: async () => {
      await app?.close()
    },
  })
}

export { fastifyAdapter }
