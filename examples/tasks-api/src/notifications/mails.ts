import { defineLayout, defineTemplate } from '@dotpress/mailer'
import { z } from 'zod'

// The emails of the notifications, in English and French: each one is sent
// in the language of its recipient. Names and titles are user input:
// `{{value}}` escapes them in the HTML version.

const layout = defineLayout({
  translations: {
    footer: {
      en: 'You receive this email because you are a member of the project.',
      fr: 'Vous recevez cet e-mail car vous êtes membre du projet.',
    },
  },
  mjml: ({ t, content, locale }) => `
<mjml lang="${locale}">
  <mj-head>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif" />
      <mj-text font-size="15px" line-height="1.5" color="#1f2933" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f4f5f7">
    <mj-section>
      <mj-column>
        <mj-text font-size="20px" font-weight="bold">Tasks</mj-text>
      </mj-column>
    </mj-section>
    ${content}
    <mj-section>
      <mj-column>
        <mj-text font-size="12px" color="#6b7280" align="center">${t('footer')}</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
})

const card = (body: string) => `
<mj-section background-color="#ffffff">
  <mj-column>${body}</mj-column>
</mj-section>`

export const taskAssignedMail = defineTemplate({
  name: 'taskAssigned',
  layout,
  schema: z.object({
    recipientName: z.string(),
    actorName: z.string(),
    taskTitle: z.string(),
    projectName: z.string(),
  }),
  subject: {
    en: 'New task for you: {{taskTitle}}',
    fr: 'Nouvelle tâche pour vous : {{taskTitle}}',
  },
  translations: {
    greeting: {
      en: 'Hello {{recipientName}},',
      fr: 'Bonjour {{recipientName}},',
    },
    body: {
      en: '{{actorName}} assigned you the task <strong>{{taskTitle}}</strong> in the {{projectName}} project.',
      fr: '{{actorName}} vous a assigné la tâche <strong>{{taskTitle}}</strong> dans le projet {{projectName}}.',
    },
  },
  mjml: ({ t }) =>
    card(`<mj-text>${t('greeting')}</mj-text><mj-text>${t('body')}</mj-text>`),
})

export const taskCompletedMail = defineTemplate({
  name: 'taskCompleted',
  layout,
  schema: z.object({
    recipientName: z.string(),
    actorName: z.string(),
    taskTitle: z.string(),
    projectName: z.string(),
  }),
  subject: {
    en: 'Task completed: {{taskTitle}}',
    fr: 'Tâche terminée : {{taskTitle}}',
  },
  translations: {
    greeting: {
      en: 'Hello {{recipientName}},',
      fr: 'Bonjour {{recipientName}},',
    },
    body: {
      en: '{{actorName}} completed the task <strong>{{taskTitle}}</strong> in the {{projectName}} project.',
      fr: '{{actorName}} a terminé la tâche <strong>{{taskTitle}}</strong> dans le projet {{projectName}}.',
    },
  },
  mjml: ({ t }) =>
    card(`<mj-text>${t('greeting')}</mj-text><mj-text>${t('body')}</mj-text>`),
})
