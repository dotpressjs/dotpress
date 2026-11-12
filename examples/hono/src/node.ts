// The Node.js entry: @hono/node-server serves the app.
import { honoAdapter } from '@dotpress/adapter-hono/node'
import { createNotesApp, honoOptions } from './app.ts'

const port = Number(process.env.PORT ?? 3000)

const app = await createNotesApp(honoAdapter(honoOptions))
await app.listen(port)
console.log(`Notes API: http://localhost:${port}/notes`)

// Waits for pending requests, then runs the onClose hooks of the plugins.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close())
}
