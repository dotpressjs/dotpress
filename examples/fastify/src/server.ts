import { createNotesApp } from './app.ts'

const port = Number(process.env.PORT ?? 3000)

const app = await createNotesApp()
await app.listen(port)
console.log(`Notes API: http://localhost:${port}/notes`)

// Closes the Fastify instance once the pending requests are served.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close())
}
