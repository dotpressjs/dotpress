import type { Mailer } from '@dotpress/mailer'
import { contactNotification } from './contact-notification.ts'
import { contactReceived } from './contact-received.ts'

export { contactNotification, contactReceived }

/**
 * Every template, with sample data checked by its schema: rendered by the
 * preview routes, and by the tests in every locale.
 */
export const previews = {
  contactReceived: {
    locales: contactReceived.locales,
    render: (mailer: Mailer, locale: string | undefined) =>
      mailer.render(contactReceived, { locale, data: { name: 'Alex' } }),
  },
  contactNotification: {
    locales: contactNotification.locales,
    render: (mailer: Mailer, locale: string | undefined) =>
      mailer.render(contactNotification, {
        locale,
        data: {
          name: 'Alex',
          email: 'alex@example.com',
          message: 'Hello,\nI would like to know more about your offer.',
          locale: 'en',
        },
      }),
  },
}

export type PreviewName = keyof typeof previews
