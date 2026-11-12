import { createMemoryProvider } from '@dotpress/mailer'
import {
  createMemoryLogger,
  expectMailSent,
  expectNoMailSent,
  memoryAdapter,
} from '@dotpress/testing'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createContactApp } from '../src/app.ts'
import { createAppMailer } from '../src/mailer.ts'
import { contactNotification, contactReceived } from '../src/mails/index.ts'

// The memory provider keeps the messages in `outbox.sent`, read by
// expectMailSent() of @dotpress/testing.
let adapter: ReturnType<typeof memoryAdapter>
let outbox: ReturnType<typeof createMemoryProvider>
let close: () => Promise<void>

beforeEach(async () => {
  adapter = memoryAdapter()
  outbox = createMemoryProvider()
  const app = await createContactApp({
    adapter,
    mailer: createAppMailer(outbox),
    contactTo: 'team@example.com',
    logger: createMemoryLogger(),
  })
  close = () => app.close()
})

afterEach(() => close())

const contact = (body: unknown, headers: Record<string, string> = {}) =>
  adapter.fetch(
    new Request('http://localhost/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  )

const form = {
  name: 'Alex',
  email: 'alex@example.com',
  message: 'Hello, I would like to know more.',
}

it('notifies the team, with the visitor as reply-to address', async () => {
  const res = await contact(form)
  expect(res.status).toBe(204)

  const mail = expectMailSent(
    outbox,
    {
      to: 'team@example.com',
      replyTo: 'alex@example.com',
      template: contactNotification,
      subject: 'Contact form: Alex',
    },
    { times: 1 }
  )
  expect(mail.html).toContain('Hello, I would like to know more.')
})

it('acknowledges the message in the language of the visitor', async () => {
  await contact(form, { 'accept-language': 'fr-CA,fr;q=0.9,en;q=0.8' })

  const mail = expectMailSent(outbox, {
    to: 'alex@example.com',
    template: contactReceived,
    locale: 'fr',
    subject: 'Nous avons bien reçu votre message, Alex',
  })
  // The acknowledgement never repeats the message: the form cannot send
  // arbitrary text to arbitrary addresses.
  expect(mail.html).not.toContain(form.message)
})

it('falls back to English for other languages', async () => {
  await contact(form, { 'accept-language': 'de-DE,de;q=0.9' })

  expectMailSent(outbox, { template: contactReceived, locale: 'en' })
})

it('sends nothing for an invalid form', async () => {
  const res = await contact({ ...form, email: 'not an address' })

  expect(res.status).toBe(400)
  expectNoMailSent(outbox)
})

it('serves no previews unless enabled', async () => {
  const res = await adapter.fetch(new Request('http://localhost/previews'))

  expect(res.status).toBe(404)
})
