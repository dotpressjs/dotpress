// The two shapes of factories: the adapter itself, or an option object.
import {
  createApp,
  createRouter,
  type HttpAdapter,
  type Router,
} from '@dotpress/core'
import { createMemoryLogger } from '@dotpress/testing'

const routers = (): Router[] => {
  const router = createRouter()
  router.defineRoute({ path: '/tasks', handler: () => [] })
  return [router]
}

export const createWithAdapter = (adapter: HttpAdapter) =>
  createApp({ adapter, logger: createMemoryLogger(), routers: routers() })

export const createWithOptions = ({
  adapter,
  basePath,
}: {
  adapter: HttpAdapter
  basePath?: string
}) =>
  createApp({
    adapter,
    logger: createMemoryLogger(),
    routers: routers(),
    ...(basePath !== undefined && { basePath }),
  })
