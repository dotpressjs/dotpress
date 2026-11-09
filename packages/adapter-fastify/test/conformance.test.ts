import { runConformanceSuite } from '@dotpress/testing'
import Fastify from 'fastify'
import { fastifyAdapter, startApp, startLambda } from './support.js'

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

for (const [format, name] of [
  ['v1', 'API Gateway REST API'],
  ['v2', 'API Gateway HTTP API'],
  ['alb', 'Application Load Balancer'],
] as const) {
  runConformanceSuite({
    name: `Fastify 5 (AWS Lambda, ${name})`,
    // Without response streaming.
    bufferedResponses: true,
    setup: async (options) => startLambda(format, options),
  })
}
