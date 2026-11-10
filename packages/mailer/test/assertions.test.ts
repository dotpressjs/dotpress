import { expectMailSent, expectNoMailSent } from '@dotpress/testing'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createMailer,
  createMemoryProvider,
  defineTemplate,
} from '../src/index.js'

const welcome = defineTemplate({
  name: 'welcome',
  schema: z.object({ name: z.string(), link: z.string() }),
  subject: { en: 'Welcome {{name}}', fr: 'Bienvenue {{name}}' },
  translations: { body: { en: 'Hello', fr: 'Bonjour' } },
  html: ({ t }) =>
    `<p>${t('body')} {{name}}</p><a href="{{{link}}}">Confirm</a>`,
})

describe('assertions of @dotpress/testing', () => {
  it('check the messages of the memory provider', async () => {
    const outbox = createMemoryProvider()
    const mailer = createMailer({
      provider: outbox,
      from: 'Acme <noreply@example.com>',
      defaultLocale: 'en',
    })
    await mailer.send(welcome, {
      to: 'Ada Lovelace <Ada@Example.com>',
      bcc: 'archive@example.com',
      locale: 'fr',
      tags: ['welcome'],
      data: { name: 'Ada', link: 'https://example.com/confirm?a=1&b=2' },
    })

    const mail = expectMailSent(
      outbox,
      {
        to: 'ada@example.com',
        bcc: 'archive@example.com',
        from: 'noreply@example.com',
        template: welcome,
        locale: 'fr',
        subject: 'Bienvenue Ada',
        tags: ['welcome'],
      },
      { times: 1 }
    )
    expect(mail.html).toContain('href="https://example.com/confirm?a=1&b=2"')
    expect(mail.text).toContain('Bonjour Ada')
    expectNoMailSent(outbox, { to: 'grace@example.com' })
    outbox.clear()
    expectNoMailSent(outbox)
  })
})
