import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLambdaHandler } from '@dotpress/adapter-fastify/lambda'
import {
  createLambdaTarget,
  createMemoryLogger,
  fromLambdaResult,
  toLambdaEvent,
  type LambdaEventFormat,
} from '@dotpress/testing'
import { describe, expect, it } from 'vitest'
import { createNotesApp } from '../src/app.ts'

// createLambdaTarget() sends each request as a simulated API Gateway event,
// and converts the result back into a Response: no AWS account needed.
describe.each<LambdaEventFormat>(['v1', 'v2'])(
  'on AWS Lambda (payload %s)',
  (format) => {
    it('serves the notes', async () => {
      let app: Awaited<ReturnType<typeof createNotesApp>> | undefined
      const handler = createLambdaHandler(
        async () =>
          (app = await createNotesApp({ logger: createMemoryLogger() }))
      )
      const lambda = createLambdaTarget(handler, {
        format,
        close: async () => app?.close(),
      })

      const created = await lambda.fetch('/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Hello Lambda' }),
      })
      expect(created.status).toBe(201)
      const note = (await created.json()) as { id: string }

      const read = await lambda.fetch(`/notes/${note.id}`)
      expect(read.status).toBe(200)

      const invalid = await lambda.fetch('/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      })
      expect(invalid.status).toBe(400)

      const health = await lambda.fetch('/health')
      expect(await health.json()).toEqual({ status: 'ok' })

      await lambda.close()
    })
  }
)

it('bundles the handler with esbuild', { timeout: 30_000 }, async () => {
  const root = join(import.meta.dirname, '..')
  execFileSync('npm', ['run', '--silent', 'build:lambda'], {
    cwd: root,
    stdio: 'pipe',
  })

  const { handler } = (await import(
    pathToFileURL(join(root, 'dist/lambda.mjs')).href
  )) as { handler: (event: unknown) => Promise<unknown> }

  const event = await toLambdaEvent(
    new Request('http://localhost/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello bundle' }),
    }),
    'v2'
  )
  const res = fromLambdaResult(await handler(event))

  expect(res.status).toBe(201)
  expect(await res.json()).toMatchObject({ text: 'Hello bundle' })
})
