import type { AddressInfo } from 'node:net'
import { createApp, type AppOptions } from '@dotpress/core'
import type { TestTarget } from '@dotpress/testing'
import { createHttpTarget } from '@dotpress/testing/conformance'
import {
  expressAdapter,
  type ExpressAdapter,
  type ExpressApplication,
} from '../src/index.js'

/**
 * Starts an app on a random port and returns a target to send requests to.
 */
export const startApp = async <TApp extends ExpressApplication>(
  adapter: ExpressAdapter<TApp>,
  options: Omit<AppOptions, 'adapter'>
): Promise<TestTarget & { adapter: ExpressAdapter<TApp> }> => {
  const app = await createApp({ ...options, adapter })
  await app.listen(0, '127.0.0.1')

  const { port } = adapter.server()!.address() as AddressInfo
  return {
    ...createHttpTarget(`http://127.0.0.1:${port}`, {
      close: () => app.close(),
    }),
    adapter,
  }
}

export { expressAdapter }
