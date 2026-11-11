import { expressAdapter } from '@dotpress/adapter-express'
import { createTasksApp } from './app.ts'

const port = Number(process.env.PORT ?? 3000)

const app = await createTasksApp({ adapter: expressAdapter() })
await app.listen(port)
console.log(`Tasks API: http://localhost:${port}/tasks`)
console.log(`API reference: http://localhost:${port}/docs`)

// Waits for pending requests, then runs the onClose hooks of the plugins.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close())
}
