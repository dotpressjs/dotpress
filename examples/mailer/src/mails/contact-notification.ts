import { defineTemplate } from '@dotpress/mailer'
import { z } from 'zod'
import { baseLayout } from './layout.ts'

/**
 * Sent to the team, in English. The message is user input: `{{message}}`
 * escapes it in the HTML version (never `{{{message}}}`).
 */
export const contactNotification = defineTemplate({
  name: 'contactNotification',
  layout: baseLayout,
  schema: z.object({
    name: z.string(),
    email: z.email(),
    message: z.string(),
    locale: z.string(),
  }),
  subject: { en: 'Contact form: {{name}}' },
  translations: {
    intro: {
      en: 'New message from {{name}} ({{email}}), in the "{{locale}}" locale. Reply to this email to answer.',
    },
  },
  mjml: ({ t }) => `
<mj-section background-color="#ffffff">
  <mj-column>
    <mj-text>${t('intro')}</mj-text>
    <mj-text><div style="white-space: pre-line">{{message}}</div></mj-text>
  </mj-column>
</mj-section>`,
})
