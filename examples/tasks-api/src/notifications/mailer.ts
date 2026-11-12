import {
  createConsoleProvider,
  createMailer,
  type MailProvider,
} from '@dotpress/mailer'
import { createSmtpProvider } from '@dotpress/mailer/smtp'
import type { Config } from '../config.ts'

/**
 * SMTP with `SMTP_URL`: Mailpit in development (compose.yaml), your email
 * service in production, where the configuration requires it. Printed in
 * the terminal otherwise.
 */
export const createMailProvider = (
  config: Pick<Config, 'SMTP_URL'>
): MailProvider & { close?(): void } =>
  config.SMTP_URL
    ? createSmtpProvider(config.SMTP_URL)
    : createConsoleProvider()

export const createAppMailer = (provider: MailProvider, from: string) =>
  createMailer({ provider, from, defaultLocale: 'en' })
