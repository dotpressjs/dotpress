import { renderMail } from '@dotpress/mailer'
import { describe, expect, it } from 'vitest'
import {
  taskAssignedMail,
  taskCompletedMail,
} from '../src/features/notifications/mails.ts'

const data = {
  recipientName: 'Bob',
  actorName: 'Alice',
  taskTitle: 'Write the homepage copy',
  projectName: 'Website launch',
}

// Every template in every locale: a missing translation or an MJML error
// fails here.
describe.each([taskAssignedMail, taskCompletedMail])('$name', (template) => {
  it.each([...template.locales])('renders in "%s"', async (locale) => {
    const mail = await renderMail(template, { locale, data })

    expect(mail.locale).toBe(locale)
    expect(mail.subject).toContain('Write the homepage copy')
    expect(mail.html).toContain(`lang="${locale}"`)
    // The text version is wrapped at 78 characters.
    expect(mail.text.replace(/\s+/g, ' ')).toContain('Website launch')
  })
})

it('escapes the names and titles in the HTML version', async () => {
  const mail = await renderMail(taskAssignedMail, {
    locale: 'en',
    data: { ...data, taskTitle: '<img src=x onerror=alert(1)>' },
  })

  expect(mail.html).not.toContain('<img src=x')
  expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
})
