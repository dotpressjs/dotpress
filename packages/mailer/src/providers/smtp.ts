// nodemailer runs on Node.js only: Buffer is available.
/// <reference types="node" />
import nodemailer, {
  type SendMailOptions,
  type SMTPPoolOptions,
  type SMTPTransportOptions,
  type Transporter,
} from 'nodemailer'
import type { MailProvider } from '../mailer.js'
import type { Address, MailAttachment, MailMessage } from '../message.js'

/** A nodemailer transporter, or any object with the same methods. */
export interface NodemailerTransporter {
  sendMail(options: SendMailOptions): Promise<{ messageId?: unknown }>
  close?(): void
}

/** Provider based on nodemailer: SMTP, or another nodemailer transport. */
export interface NodemailerProvider extends MailProvider {
  /** Closes the connections of the transporter (`pool: true`). */
  close(): void
}

/**
 * Options of `createSmtpProvider()`: the SMTP options of nodemailer
 * (`host`, `port`, `secure`, `auth`, `pool`…), or a connection URL like
 * `smtps://user:password@smtp.example.com`.
 */
export type SmtpProviderOptions =
  SMTPTransportOptions | SMTPPoolOptions | string

const toAddress = ({ name, address }: Address) =>
  name ? { name, address } : address

const toAttachment = ({
  filename,
  content,
  contentType,
  contentId,
}: MailAttachment) => ({
  filename,
  // nodemailer takes Buffers, not plain Uint8Arrays (no copy).
  content:
    typeof content === 'string'
      ? content
      : Buffer.from(content.buffer, content.byteOffset, content.byteLength),
  ...(contentType === undefined ? {} : { contentType }),
  // nodemailer defaults to `attachment`.
  ...(contentId === undefined
    ? {}
    : { cid: contentId, contentDisposition: 'inline' as const }),
})

/** nodemailer options of a message. */
const toNodemailerMessage = (message: MailMessage): SendMailOptions => ({
  from: toAddress(message.from),
  to: message.to.map(toAddress),
  cc: message.cc.map(toAddress),
  bcc: message.bcc.map(toAddress),
  replyTo: message.replyTo.map(toAddress),
  subject: message.subject,
  text: message.text,
  html: message.html,
  attachments: message.attachments.map(toAttachment),
  headers: { ...message.headers },
})

/** Options of `createNodemailerProvider()`. */
export interface NodemailerProviderOptions {
  /** Name of the provider, in the logs. Defaults to `nodemailer`. */
  name?: string | undefined
}

/**
 * Creates a provider from a nodemailer transporter: SMTP, sendmail,
 * Amazon SES through nodemailer, or a stream transport for tests.
 */
export const createNodemailerProvider = (
  transporter: NodemailerTransporter,
  options: NodemailerProviderOptions = {}
): NodemailerProvider => {
  const label = 'createNodemailerProvider()'
  if (typeof transporter?.sendMail !== 'function') {
    throw new TypeError(`${label}: expected a nodemailer transporter.`)
  }
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${label}: options must be an object.`)
  }
  for (const key of Object.keys(options)) {
    if (key !== 'name') {
      throw new TypeError(`${label}: unknown option "${key}".`)
    }
  }
  const { name = 'nodemailer' } = options
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(`${label}: name must be a non-empty string.`)
  }
  return {
    name,
    send: async (message) => {
      const { messageId } = await transporter.sendMail(
        toNodemailerMessage(message)
      )
      // Checked by the mailer.
      return { messageId: messageId as string | undefined }
    },
    close: () => transporter.close?.(),
  }
}

/**
 * Creates a provider that sends messages to an SMTP server, through
 * nodemailer (peer dependency). Also works with the SMTP interface of
 * Amazon SES, Postmark, Mailgun, Brevo, Mailjet…
 *
 * ```ts
 * const provider = createSmtpProvider({
 *   host: 'smtp.example.com',
 *   port: 465,
 *   secure: true,
 *   auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
 * })
 * ```
 */
export const createSmtpProvider = (
  options: SmtpProviderOptions
): NodemailerProvider => {
  if (
    typeof options !== 'string' &&
    (typeof options !== 'object' || options === null)
  ) {
    throw new TypeError(
      'createSmtpProvider(): expected SMTP options or a connection URL.'
    )
  }
  const transporter: Transporter = nodemailer.createTransport(
    options as SMTPTransportOptions
  )
  return createNodemailerProvider(transporter, { name: 'smtp' })
}
