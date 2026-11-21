// The app module of the quickstart: a single export, a factory taking the
// adapter.
import { createApp, createRouter, type HttpAdapter } from '@dotpress/core'
import { createMemoryLogger } from '@dotpress/testing'

const router = createRouter()
router.defineRoute({ path: '/notes', handler: () => [] })

export const createNotesApp = <TAdapter extends HttpAdapter>(
  adapter: TAdapter
) => createApp({ adapter, logger: createMemoryLogger(), routers: [router] })
