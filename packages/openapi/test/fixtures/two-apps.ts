// Creates two apps at import.
import { createApp, createRouter } from '@dotpress/core'
import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'

const create = () =>
  createApp({
    adapter: memoryAdapter(),
    logger: createMemoryLogger(),
    routers: [createRouter()],
  })

export const publicApp = await create()
export const adminApp = await create()
