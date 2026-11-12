import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'
import { describe, expect, it } from 'vitest'
import { createOrdersApp } from '../src/app.ts'
import { createBus, createTransport, redisConnection } from '../src/bus.ts'
import { startWarehouse } from './support.ts'

it('reads the Redis URL', () => {
  expect(
    redisConnection('rediss://user:p%40ss@cache.example.com:6380/2')
  ).toEqual({
    host: 'cache.example.com',
    port: 6380,
    username: 'user',
    password: 'p@ss',
    db: 2,
    tls: {},
    maxRetriesPerRequest: null,
  })
})

// The production setup: the API queues the events in Redis, and the
// command `dotpress-events work` runs the listeners in another process.
// REDIS_URL=redis://localhost:6379 (docker compose up -d); skipped without.
const redisUrl = process.env.REDIS_URL

describe.skipIf(!redisUrl)('with Redis', () => {
  it(
    'runs the listeners in the worker process',
    { timeout: 30_000 },
    async () => {
      const root = join(import.meta.dirname, '..')
      const warehouse = await startWarehouse()
      const env = {
        ...process.env,
        REDIS_URL: redisUrl,
        // A queue of its own: tests running at the same time do not share it.
        EVENTS_QUEUE: `orders-test-${process.pid}-${Date.now()}`,
        WAREHOUSE_URL: warehouse.url,
      }

      const worker = spawn(
        join(root, 'node_modules/.bin/dotpress-events'),
        ['work', 'src/worker.ts'],
        { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let output = ''
      worker.stdout.on('data', (chunk) => (output += chunk))
      worker.stderr.on('data', (chunk) => (output += chunk))

      const transport = createTransport(env)
      expect(transport.kind).toBe('bullmq')
      const adapter = memoryAdapter()
      const app = await createOrdersApp({
        adapter,
        events: createBus(transport),
        logger: createMemoryLogger(),
      })

      try {
        const res = await adapter.fetch(
          new Request('http://localhost/orders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items: [{ sku: 'BOOK-1', quantity: 3 }] }),
          })
        )
        expect(res.status).toBe(201)
        const order = (await res.json()) as { id: string }

        await warehouse.received(1)
        expect(warehouse.requests[0]?.body).toEqual({
          orderId: order.id,
          items: [{ sku: 'BOOK-1', quantity: 3 }],
        })
      } finally {
        await app.close()
        await transport.close()
        await warehouse.close()
        // Graceful stop: the worker finishes the jobs in progress, and exits.
        worker.kill('SIGTERM')
        const [code] = await once(worker, 'exit')
        expect(code, output).toBe(0)
      }

      expect(output).toContain('Order confirmation sent')
    }
  )
})
