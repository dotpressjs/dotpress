import { createRouter, empty, notFoundError, text } from '@dotpress/core'
import type { Mailer } from '@dotpress/mailer'
import { negotiateLocale } from './locale.ts'
import {
  contactNotification,
  contactReceived,
  previews,
  type PreviewName,
} from './mails/index.ts'

/** The contact form: one email to the team, one to the visitor. */
export const contactRouter = (contactTo: string) => {
  const router = createRouter()

  router.defineRoute({
    method: 'post',
    path: '/contact',
    status: 204,
    schema: (z) => ({
      body: z.object({
        name: z.string().trim().min(1).max(100),
        email: z.email(),
        message: z.string().trim().min(1).max(5000),
      }),
    }),
    meta: { summary: 'Send a message to the team', tags: ['contact'] },
    // ctx.mailer comes from mailerPlugin, and logs with the request logger.
    handler: async ({ req, mailer }) => {
      const { name, email, message } = req.body
      // fr-CA,fr;q=0.9 → fr; unsupported languages → the default locale.
      const locale = negotiateLocale(
        req.header('accept-language'),
        contactReceived.locales
      )

      await mailer.send(contactNotification, {
        to: contactTo,
        // The team answers the visitor with the Reply button.
        replyTo: { name, address: email },
        data: { name, email, message, locale: locale ?? 'en' },
      })
      await mailer.send(contactReceived, {
        to: { name, address: email },
        locale,
        data: { name },
      })
      return empty()
    },
  })

  return router
}

const previewNames = Object.keys(previews) as PreviewName[]

const page = (html: string) =>
  text(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })

/**
 * Previews of the templates in the browser, with sample data: for
 * development only.
 */
export const previewsRouter = (mailer: Mailer) => {
  const router = createRouter()

  router.defineRoute({
    path: '/previews',
    handler: () =>
      page(
        `<!doctype html><title>Email previews</title><ul>${previewNames
          .flatMap((name) =>
            previews[name].locales.map(
              (locale) =>
                `<li><a href="/previews/${name}?locale=${locale}">${name} (${locale})</a></li>`
            )
          )
          .join('')}</ul>`
      ),
  })

  router.defineRoute({
    path: '/previews/:template',
    schema: (z) => ({
      query: z.object({ locale: z.string().optional() }),
    }),
    handler: async ({ req }) => {
      const name = req.params.template
      if (!(previewNames as string[]).includes(name)) {
        return notFoundError('Unknown template')
      }
      const mail = await previews[name as PreviewName].render(
        mailer,
        req.query.locale
      )
      return page(mail.html)
    },
  })

  return router
}
