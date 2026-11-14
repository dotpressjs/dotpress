import { runConformanceSuite } from '@dotpress/testing/conformance'
import express4 from 'express-4'
import { expressAdapter, startApp } from './support.js'

runConformanceSuite({
  name: 'Express 5',
  setup: (options) => startApp(expressAdapter(), options),
})

runConformanceSuite({
  name: 'Express 4',
  setup: (options) => {
    const app = express4()
    app.disable('x-powered-by')
    app.disable('etag')
    return startApp(expressAdapter({ app }), options)
  },
})
