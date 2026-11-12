import { expressAdapter } from '@dotpress/adapter-express'
import { generatePasswordHash } from '@dotpress/auth'
import { createNotesApp } from './app.ts'
import { loadKeys } from './keys.ts'
import { createStore } from './store.ts'

const port = Number(process.env.PORT ?? 3000)

const keys = loadKeys()
if (keys.generated) {
  console.warn(
    'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are not set: using a temporary key pair, the tokens stop working at restart.'
  )
}

const store = createStore()
// Optional administrator account, to try the /admin routes.
if (process.env.ADMIN_PASSWORD) {
  await store.users.create({
    username: process.env.ADMIN_USERNAME ?? 'admin',
    passwordHash: await generatePasswordHash(process.env.ADMIN_PASSWORD),
    role: 'admin',
  })
}

const app = await createNotesApp({
  adapter: expressAdapter(),
  keys,
  store,
  issuer: process.env.JWT_ISSUER ?? `http://localhost:${port}`,
})
await app.listen(port)
console.log(`Notes API: http://localhost:${port}`)
console.log(`API reference: http://localhost:${port}/docs`)

// Waits for pending requests, then runs the onClose hooks of the plugins.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close())
}
