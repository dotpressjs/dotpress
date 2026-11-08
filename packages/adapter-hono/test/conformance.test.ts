import { runConformanceSuite } from '@dotpress/testing'
import { Hono as Hono5 } from 'hono-5'
import { honoAdapter } from '../src/node.js'
import { memoryHono, startFetch, startNode } from './support.js'

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
