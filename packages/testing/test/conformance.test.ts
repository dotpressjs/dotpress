import {
  createTestApp,
  runConformanceSuite,
  type TestAppOptions,
} from '../src/index.js'

// The memory adapter is the reference adapter: it must pass the suite too.
runConformanceSuite({
  name: 'memory',
  async setup(options) {
    // The suite always gives a memory logger.
    const { fetch, close } = await createTestApp(options as TestAppOptions)
    return { fetch, close }
  },
})
