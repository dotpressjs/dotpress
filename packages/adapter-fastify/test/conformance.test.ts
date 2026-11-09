import { runConformanceSuite } from '@dotpress/testing'
import Fastify from 'fastify'
import { fastifyAdapter, startApp } from './support.js'

runConformanceSuite({
  name: 'Fastify 5',
  setup: (options) => startApp(fastifyAdapter(), options),
})

// The routing rules of Dotpress apply whatever the router options.
runConformanceSuite({
  name: 'Fastify 5 (custom router options)',
  setup: (options) =>
    startApp(
      fastifyAdapter({
        app: Fastify({
          routerOptions: { ignoreTrailingSlash: true },
          exposeHeadRoutes: false,
        }),
      }),
      options
    ),
})
