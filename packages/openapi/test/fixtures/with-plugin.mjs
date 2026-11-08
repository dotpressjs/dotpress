// App with openapiPlugin(), exported as is.
import { createRouter, definePlugin } from '@dotpress/core'
import { createTestApp } from '@dotpress/testing'
import { openapiPlugin } from '../../src/index.ts'

const router = createRouter()
router.defineRoute({ path: '/users/:id', handler: () => ({}) })

const closing = definePlugin({
  name: 'closing',
  setup(api) {
    api.hooks.onClose(() => {
      globalThis.fixtureClosed = true
    })
  },
})

// Another plugin with a getDocument() method: not the OpenAPI plugin.
const decoy = definePlugin({
  name: 'decoy',
  getDocument: () => ({ openapi: 'decoy' }),
  setup() {},
})

const { app } = await createTestApp({
  routers: [router],
  plugins: [
    closing,
    decoy,
    openapiPlugin({ info: { title: 'Plugin API', version: '9.0.0' } }),
  ],
})

export default app
