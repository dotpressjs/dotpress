import { runConformanceSuite } from '@dotpress/testing'
import { Hono as Hono5 } from 'hono-5'
import { honoAdapter } from '../src/node.js'
import { memoryHono, startFetch, startLambda, startNode } from './support.js'

runConformanceSuite({
  name: 'Hono 4 (Node.js)',
  setup: (options) => startNode(honoAdapter(), options),
})

runConformanceSuite({
  name: 'Hono 5 (Node.js)',
  setup: (options) => startNode(honoAdapter({ app: new Hono5() }), options),
})

runConformanceSuite({
  name: 'Hono 4 (fetch)',
  setup: (options) => startFetch(memoryHono(), options),
})

runConformanceSuite({
  name: 'Hono 5 (fetch)',
  setup: (options) => startFetch(memoryHono(new Hono5()), options),
})

for (const [format, name] of [
  ['v1', 'API Gateway REST API'],
  ['v2', 'API Gateway HTTP API'],
  ['alb', 'Application Load Balancer'],
] as const) {
  runConformanceSuite({
    name: `Hono 4 (AWS Lambda, ${name})`,
    // Without response streaming.
    bufferedResponses: true,
    setup: async (options) => startLambda(format, options),
  })
}
