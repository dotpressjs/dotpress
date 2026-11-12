import { honoAdapter } from '@dotpress/adapter-hono/node'
import { createContactApp } from './app.ts'
import { createAppMailer, createProvider } from './mailer.ts'

const port = Number(process.env.PORT ?? 3000)
const development = process.env.NODE_ENV !== 'production'

const provider = createProvider()
if (provider.name === 'console') {
  console.warn('SMTP_URL is not set: the messages are printed, not sent.')
}

const app = await createContactApp({
  adapter: honoAdapter(),
  mailer: createAppMailer(provider, process.env.MAIL_FROM),
  contactTo: process.env.CONTACT_TO ?? 'team@example.com',
  previews: development,
})
await app.listen(port)
console.log(`Contact form: POST http://localhost:${port}/contact`)
if (development) {
  console.log(`Email previews: http://localhost:${port}/previews`)
}

// Waits for pending requests, then closes the SMTP connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => provider.close?.())
  })
}
