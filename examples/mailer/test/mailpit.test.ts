import { createMemoryLogger, memoryAdapter } from '@dotpress/testing'
import { describe, expect, it } from 'vitest'
import { createContactApp } from '../src/app.ts'
import { createAppMailer, createProvider } from '../src/mailer.ts'

// The emails sent over SMTP to Mailpit, read back with its API. Local only:
//   docker compose up -d
//   SMTP_URL=smtp://localhost:1025 MAILPIT_URL=http://localhost:8025 npm test
const smtpUrl = process.env.SMTP_URL
const mailpitUrl = process.env.MAILPIT_URL

interface MailpitMessage {
  ID: string
  Subject: string
  To: { Address: string }[]
  ReplyTo: { Address: string }[]
}

/** The messages received by Mailpit for an address. */
const received = async (address: string) => {
  const res = await fetch(
    `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`
  )
  return ((await res.json()) as { messages: MailpitMessage[] }).messages
}

describe.skipIf(!smtpUrl || !mailpitUrl)('with Mailpit', () => {
  it('sends the emails over SMTP', { timeout: 15_000 }, async () => {
    // Addresses of their own: earlier runs do not interfere.
    const visitor = `visitor-${Date.now()}@example.com`
    const team = `team-${Date.now()}@example.com`
    const provider = createProvider({ SMTP_URL: smtpUrl })
    const adapter = memoryAdapter()
    const app = await createContactApp({
      adapter,
      mailer: createAppMailer(provider),
      contactTo: team,
      logger: createMemoryLogger(),
    })

    try {
      const res = await adapter.fetch(
        new Request('http://localhost/contact', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'accept-language': 'fr',
          },
          body: JSON.stringify({
            name: 'Alex',
            email: visitor,
            message: 'Hello',
          }),
        })
      )
      expect(res.status).toBe(204)

      const [acknowledgement] = await received(visitor)
      expect(acknowledgement?.Subject).toBe(
        'Nous avons bien reçu votre message, Alex'
      )
      const [notification] = await received(team)
      expect(notification?.Subject).toBe('Contact form: Alex')
      expect(notification?.ReplyTo).toEqual([
        expect.objectContaining({ Address: visitor }),
      ])

      // The HTML part, as delivered.
      const html = await fetch(`${mailpitUrl}/view/${acknowledgement?.ID}.html`)
      expect(await html.text()).toContain('Bonjour Alex,')
    } finally {
      await app.close()
      provider.close?.()
    }
  })
})
