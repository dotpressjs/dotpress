import { describe, expect, it } from 'vitest'
import { createMailProvider } from '../src/notifications/mailer.ts'
import { startApp } from './support.ts'

// The emails sent over SMTP to Mailpit, read back with its API. Local only:
//   docker compose up -d
//   SMTP_URL=smtp://localhost:1025 MAILPIT_URL=http://localhost:8025 npm test
const smtpUrl = process.env.SMTP_URL
const mailpitUrl = process.env.MAILPIT_URL

describe.skipIf(!smtpUrl || !mailpitUrl)('with Mailpit', () => {
  it(
    'delivers the notification of Bob, in French',
    { timeout: 15_000 },
    async () => {
      const provider = createMailProvider({ SMTP_URL: smtpUrl })
      const api = await startApp({ mailProvider: provider })

      try {
        // Addresses of their own: earlier runs do not interfere.
        const suffix = Date.now()
        const alice = await api.signUp(`Alice${suffix}`)
        const bob = await api.signUp(`Bob${suffix}`, { language: 'fr' })
        const projectId = await api.createProject(alice, `Bob${suffix}`)
        await api.send(
          'POST',
          `/projects/${projectId}/tasks`,
          { title: 'Review', assigneeId: bob.userId },
          alice.headers
        )
        await api.drain()

        const query = encodeURIComponent(`to:"bob${suffix}@example.com"`)
        const res = await fetch(`${mailpitUrl}/api/v1/search?query=${query}`)
        const { messages } = (await res.json()) as {
          messages: { Subject: string }[]
        }
        expect(messages.map((message) => message.Subject)).toEqual([
          'Nouvelle tâche pour vous : Review',
        ])
      } finally {
        await api.close()
        provider.close?.()
      }
    }
  )
})
