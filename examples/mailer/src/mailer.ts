import {
  createConsoleProvider,
  createMailer,
  type MailProvider,
} from '@dotpress/mailer'
import { createSmtpProvider } from '@dotpress/mailer/smtp'

type Env = Record<string, string | undefined>

/**
 * With `SMTP_URL`, the messages are sent over SMTP: Mailpit in development
 * (compose.yaml), your email service in production (most of them have an
 * SMTP interface). Without it, they are printed, in development only: in
 * production, a missing configuration must fail at startup, not lose the
 * messages.
 */
export const createProvider = (
  env: Env = process.env
): MailProvider & { close?(): void } => {
  if (env.SMTP_URL) return createSmtpProvider(env.SMTP_URL)
  if (env.NODE_ENV === 'production') {
    throw new Error('SMTP_URL is required.')
  }
  return createConsoleProvider()
}

/** The mailer: `mailerPlugin` gives it the logger of each request. */
export const createAppMailer = (
  provider: MailProvider,
  from = 'Example <noreply@example.com>'
) => createMailer({ provider, from, defaultLocale: 'en' })
