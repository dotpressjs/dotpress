import { MailerError, MailSendError } from './errors.js'
import {
  checkKeys,
  parseAddress,
  parseEnvelope,
  parseRecipients,
  toSubject,
  type Envelope,
  type EnvelopeOptions,
  type MailAddress,
  type MailMessage,
  type MailRecipients,
} from './message.js'
import {
  renderMail,
  toText,
  type DataOption,
  type RenderedMail,
  type RenderMailOptions,
} from './render.js'
import type { MailTemplate } from './template.js'

/** Result of a provider. */
export interface ProviderResult {
  /** Identifier of the message given by the provider, if any. */
  messageId?: string | undefined
}

/**
 * Sends messages: SMTP server, email API, test outbox… Throw a
 * `MailSendError` on failure, or a `MailMessageError` for a message the
 * provider cannot send; other errors are wrapped in a `MailSendError`.
 */
export interface MailProvider {
  /** Name used in errors and logs, like `smtp`. */
  readonly name: string
  send(message: MailMessage): Promise<ProviderResult | void>
}

/**
 * Logger of the mailer. A Dotpress or Pino logger fits; `mailerPlugin` uses
 * the logger of the request.
 */
export interface MailerLogger {
  info(data: object, message: string): void
}

/** Options of `createMailer()`. */
export interface MailerOptions {
  provider: MailProvider
  /** Default sender: `'Acme <noreply@acme.com>'`. */
  from: MailAddress
  /** Default reply-to addresses. */
  replyTo?: MailRecipients | undefined
  /** Locale used when the requested one is not available. */
  defaultLocale?: string | undefined
  /** Logs each sent message (template, provider, message ID). */
  logger?: MailerLogger | undefined
}

/** Options of `mailer.send()`. */
export type SendMailOptions<TData> = EnvelopeOptions & {
  /** Overrides the subject of the template. */
  subject?: string | undefined
  /** Locale to render, like `fr-CA` (see `renderMail()`). */
  locale?: string | undefined
} & DataOption<TData>

/** Options of `mailer.sendMessage()`: a message rendered elsewhere. */
export interface MessageOptions extends EnvelopeOptions {
  subject: string
  /** HTML version. At least one of `html` and `text` is required. */
  html?: string | undefined
  /** Text version. Converted from the HTML version if missing. */
  text?: string | undefined
}

/** Result of a sent message. */
export interface SendResult {
  /** Identifier of the message given by the provider, if any. */
  readonly messageId: string | undefined
}

export interface Mailer {
  readonly provider: MailProvider
  /** Renders a template, then sends it. */
  send<TData>(
    template: MailTemplate<TData>,
    options: SendMailOptions<NoInfer<TData>>
  ): Promise<SendResult>
  /**
   * Renders a template without sending it. The default locale is the one
   * of the mailer.
   */
  render<TData>(
    template: MailTemplate<TData>,
    options: RenderMailOptions<NoInfer<TData>>
  ): Promise<RenderedMail>
  /** Sends a message rendered elsewhere. */
  sendMessage(options: MessageOptions): Promise<SendResult>
  /** The same mailer, with another logger. */
  withLogger(logger: MailerLogger): Mailer
}

const MAILER_OPTIONS = new Set([
  'provider',
  'from',
  'replyTo',
  'defaultLocale',
  'logger',
])
const ENVELOPE_OPTIONS = [
  'to',
  'cc',
  'bcc',
  'replyTo',
  'from',
  'attachments',
  'headers',
  'tags',
  'metadata',
  'subject',
]
const SEND_OPTIONS = new Set([...ENVELOPE_OPTIONS, 'locale', 'data'])
const MESSAGE_OPTIONS = new Set([...ENVELOPE_OPTIONS, 'html', 'text'])

const checkLogger = (logger: unknown) => {
  if (typeof (logger as MailerLogger | null)?.info !== 'function') {
    throw new TypeError('Invalid mailer logger: expected an info() method.')
  }
}

/** Freezes a message and its lists. */
const freeze = (message: MailMessage): MailMessage => {
  for (const value of Object.values(message)) {
    if (typeof value === 'object' && value !== null) Object.freeze(value)
  }
  return Object.freeze(message)
}

/**
 * Creates a mailer: renders templates and sends messages through a
 * provider.
 *
 * ```ts
 * const mailer = createMailer({
 *   provider: createSmtpProvider({ host: 'smtp.example.com' }),
 *   from: 'Acme <noreply@acme.com>',
 *   defaultLocale: 'en',
 * })
 * await mailer.send(welcome, { to: user.email, locale: user.locale, data })
 * ```
 */
export const createMailer = (options: MailerOptions): Mailer => {
  const values = checkKeys('Invalid mailer options', options, MAILER_OPTIONS)
  const { provider, defaultLocale, logger } = values as Partial<MailerOptions>
  if (
    typeof provider?.name !== 'string' ||
    provider.name === '' ||
    typeof provider.send !== 'function'
  ) {
    throw new TypeError(
      'Invalid mailer options: provider must have a name and a send() method.'
    )
  }
  if (
    defaultLocale !== undefined &&
    (typeof defaultLocale !== 'string' || defaultLocale === '')
  ) {
    throw new TypeError(
      'Invalid mailer options: defaultLocale must be a non-empty string.'
    )
  }
  if (logger !== undefined) checkLogger(logger)
  if (values.from === undefined) {
    throw new TypeError('Invalid mailer options: from is required.')
  }

  const defaults = {
    from: parseAddress(values.from, 'from'),
    replyTo: parseRecipients(values.replyTo, 'replyTo'),
  }

  const create = (logger: MailerLogger | undefined): Mailer => {
    const deliver = async (
      envelope: Envelope,
      content: Pick<
        MailMessage,
        'subject' | 'html' | 'text' | 'template' | 'locale'
      >
    ): Promise<SendResult> => {
      const message = freeze({ ...envelope, ...content })
      let result: ProviderResult | void
      try {
        result = await provider.send(message)
      } catch (error) {
        // Send errors, and limits of the provider (MailMessageError).
        if (error instanceof MailerError) throw error
        throw new MailSendError(
          provider.name,
          error instanceof Error ? error.message : String(error),
          { cause: error }
        )
      }

      const messageId =
        typeof result?.messageId === 'string' ? result.messageId : undefined
      logger?.info(
        {
          provider: provider.name,
          template: message.template,
          messageId,
          recipients:
            message.to.length + message.cc.length + message.bcc.length,
        },
        'Mail sent'
      )
      return { messageId }
    }

    const render: Mailer['render'] = (template, renderOptions) =>
      renderMail(template, {
        defaultLocale,
        ...renderOptions,
      } as never)

    const mailer: Mailer = {
      provider,

      render,

      send: async (template, sendOptions) => {
        const { subject, locale, data, ...envelopeOptions } = checkKeys(
          'mailer.send()',
          sendOptions,
          SEND_OPTIONS
        ) as unknown as SendMailOptions<unknown>
        if (subject !== undefined && typeof subject !== 'string') {
          throw new TypeError('mailer.send(): subject must be a string.')
        }
        // Checked before rendering: an invalid address fails fast.
        const envelope = parseEnvelope(envelopeOptions, defaults)
        const mail = await render(template, { locale, data } as never)
        return deliver(envelope, {
          subject: subject === undefined ? mail.subject : toSubject(subject),
          html: mail.html,
          text: mail.text,
          template: mail.template,
          locale: mail.locale,
        })
      },

      sendMessage: async (messageOptions) => {
        const { subject, html, text, ...envelopeOptions } = checkKeys(
          'mailer.sendMessage()',
          messageOptions,
          MESSAGE_OPTIONS
        ) as unknown as MessageOptions
        if (typeof subject !== 'string') {
          throw new TypeError('mailer.sendMessage(): subject must be a string.')
        }
        for (const [key, value] of [
          ['html', html],
          ['text', text],
        ] as const) {
          if (value !== undefined && typeof value !== 'string') {
            throw new TypeError(
              `mailer.sendMessage(): ${key} must be a string.`
            )
          }
        }
        if (html === undefined && text === undefined) {
          throw new TypeError('mailer.sendMessage(): set html, text, or both.')
        }
        const envelope = parseEnvelope(envelopeOptions, defaults)
        return deliver(envelope, {
          subject: toSubject(subject),
          html,
          text: text ?? (await toText(html as string)),
          template: undefined,
          locale: undefined,
        })
      },

      withLogger: (other) => {
        checkLogger(other)
        return create(other)
      },
    }
    return Object.freeze(mailer)
  }

  return create(logger)
}
