import { honoAdapter } from '@dotpress/adapter-hono/node'
import { createMemoryProvider } from '@dotpress/mailer'
import { createMemoryLogger, expectMailSent } from '@dotpress/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createContactApp } from '../src/app.ts'
import { createAppMailer, createProvider } from '../src/mailer.ts'

// The app served by Node.js (@hono/node-server), with the previews of
// development, reached over HTTP.
let baseUrl: string
const outbox = createMemoryProvider()
let close: () => Promise<void>

beforeAll(async () => {
  const adapter = honoAdapter()
  const app = await createContactApp({
    adapter,
    mailer: createAppMailer(outbox),
    contactTo: 'team@example.com',
    previews: true,
    logger: createMemoryLogger(),
  })
  const { port } = await app.listen(0, '127.0.0.1')
  baseUrl = `http://127.0.0.1:${port}`
  close = () => app.close()
})

afterAll(() => close())

it('sends the emails of the contact form', async () => {
  const res = await fetch(`${baseUrl}/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Alex',
      email: 'alex@example.com',
      message: 'Hello',
    }),
  })

  expect(res.status).toBe(204)
  expect(outbox.sent).toHaveLength(2)
  expectMailSent(outbox, { to: 'alex@example.com' })
})

it('lists and renders the previews', async () => {
  const index = await fetch(`${baseUrl}/previews`)
  expect(index.headers.get('content-type')).toContain('text/html')
  expect(await index.text()).toContain('/previews/contactReceived?locale=fr')

  const preview = await fetch(`${baseUrl}/previews/contactReceived?locale=fr`)
  expect(preview.status).toBe(200)
  expect(await preview.text()).toContain('Bonjour Alex,')

  const unknown = await fetch(`${baseUrl}/previews/nope`)
  expect(unknown.status).toBe(404)
})

it('prints the messages in development, and requires SMTP in production', () => {
  expect(createProvider({}).name).toBe('console')
  expect(createProvider({ SMTP_URL: 'smtp://localhost:1025' }).name).toBe(
    'smtp'
  )
  expect(() => createProvider({ NODE_ENV: 'production' })).toThrow(
    'SMTP_URL is required.'
  )
})
