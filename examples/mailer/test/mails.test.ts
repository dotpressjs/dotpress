import { createMemoryProvider, renderMail } from '@dotpress/mailer'
import { describe, expect, it } from 'vitest'
import {
  contactNotification,
  contactReceived,
  previews,
  type PreviewName,
} from '../src/mails/index.ts'
import { createAppMailer } from '../src/mailer.ts'

const mailer = createAppMailer(createMemoryProvider())

// Every template renders in every locale, with the sample data of the
// previews: a missing translation or an MJML error fails here.
describe.each(Object.keys(previews) as PreviewName[])('%s', (name) => {
  it.each([...previews[name].locales])('renders in "%s"', async (locale) => {
    const mail = await previews[name].render(mailer, locale)

    expect(mail.locale).toBe(locale)
    expect(mail.subject).not.toBe('')
    expect(mail.html).toContain(`lang="${locale}"`)
    // The text version is converted from the HTML version.
    expect(mail.text).toContain('Alex')
  })
})

it('translates the acknowledgement', async () => {
  const mail = await renderMail(contactReceived, {
    locale: 'fr',
    data: { name: 'Alex' },
  })

  expect(mail.subject).toBe('Nous avons bien reçu votre message, Alex')
  expect(mail.html).toContain('Bonjour Alex,')
  expect(mail.html).toContain('Exempleville')
})

it('escapes the message of the visitor in the HTML version', async () => {
  const mail = await renderMail(contactNotification, {
    locale: 'en',
    data: {
      name: 'Alex <b>',
      email: 'alex@example.com',
      message: '<script>alert(1)</script>',
      locale: 'en',
    },
  })

  expect(mail.html).not.toContain('<script>')
  expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(mail.html).toContain('Alex &lt;b&gt;')
  // The subject and the text version are not HTML: inserted as-is.
  expect(mail.subject).toBe('Contact form: Alex <b>')
})
