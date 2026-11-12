import { defineTemplate } from '@dotpress/mailer'
import { z } from 'zod'
import { baseLayout } from './layout.ts'

/**
 * Sent to the visitor, in their language. It does not repeat the message:
 * otherwise, anyone could send any text to any address through the form.
 */
export const contactReceived = defineTemplate({
  name: 'contactReceived',
  layout: baseLayout,
  schema: z.object({ name: z.string() }),
  // {{name}} is inserted by Mustache, after the translations.
  subject: {
    en: 'We received your message, {{name}}',
    fr: 'Nous avons bien reçu votre message, {{name}}',
  },
  translations: {
    greeting: { en: 'Hello {{name}},', fr: 'Bonjour {{name}},' },
    body: {
      en: 'Thank you for contacting us. We will answer within two business days.',
      fr: 'Merci de nous avoir contactés. Nous vous répondrons sous deux jours ouvrés.',
    },
    signature: { en: 'The Example team', fr: 'L’équipe Example' },
  },
  mjml: ({ t }) => `
<mj-section background-color="#ffffff">
  <mj-column>
    <mj-text>${t('greeting')}</mj-text>
    <mj-text>${t('body')}</mj-text>
    <mj-text>${t('signature')}</mj-text>
  </mj-column>
</mj-section>`,
})
