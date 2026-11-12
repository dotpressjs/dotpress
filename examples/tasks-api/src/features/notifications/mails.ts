import { defineTemplate } from '@dotpress/mailer'
import { z } from 'zod'
import { mailLayout as layout } from '../../mails/layout.ts'

// The emails of the notifications, in English and French, in the shared
// layout of the app: each one is sent in the language of its recipient. Names and titles are user input:
// `{{value}}` escapes them in the HTML version.

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
