import type { AddressInfo } from 'node:net'
import { createApp, type AppOptions } from '@dotpress/core'
import {
  createFetchTarget,
  createHttpTarget,
  createLambdaTarget,
  type ConformanceTarget,
  type LambdaEventFormat,
} from '@dotpress/testing'
import { honoAdapter, type HonoAdapter } from '../src/index.js'
import type { HonoApplication } from '../src/index.js'
import { createLambdaHandler } from '../src/lambda.js'
import type { NodeHonoAdapter } from '../src/node.js'

type AppSetup = Omit<AppOptions, 'adapter'>

/**
 * Starts an app on a random port and returns a target to send requests to.
 */
export const startNode = async <TApp extends HonoApplication>(
  adapter: NodeHonoAdapter<TApp>,
  options: AppSetup
): Promise<ConformanceTarget> => {
  const app = await createApp({ ...options, adapter })
  await app.listen(0, '127.0.0.1')

  const { port } = adapter.server()!.address() as AddressInfo
  return createHttpTarget(`http://127.0.0.1:${port}`, () => app.close())
}

/** Creates an app and returns a target calling `adapter.fetch()`. */
export const startFetch = async <TApp extends HonoApplication>(
  adapter: HonoAdapter<TApp>,
  options: AppSetup
): Promise<ConformanceTarget> => {
  const app = await createApp({ ...options, adapter })
  return createFetchTarget(
    (request) => adapter.fetch(request),
    () => app.close()
  )
}

/** In-memory adapter, with the loopback address of the conformance suite. */
export const memoryHono = <TApp extends HonoApplication>(app?: TApp) =>
  honoAdapter({
    ...(app ? { app } : {}),
    getIp: () => '127.0.0.1',
  } as { app: TApp; getIp: () => string })

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
    const created = await createApp({ ...options, adapter: honoAdapter() })
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
