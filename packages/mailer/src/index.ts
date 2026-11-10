export {
  MailDataError,
  MailerError,
  MailMessageError,
  MailRenderError,
  MailSendError,
} from './errors.js'
export type { MailDataIssue, MailSendErrorOptions } from './errors.js'
export type { Localized, Translations } from './locales.js'
export { createMailer } from './mailer.js'
export type {
  Mailer,
  MailerLogger,
  MailerOptions,
  MailProvider,
  MessageOptions,
  ProviderResult,
  SendMailOptions,
  SendResult,
} from './mailer.js'
export { formatAddress } from './message.js'
export type {
  Address,
  EnvelopeOptions,
  MailAddress,
  MailAttachment,
  MailMessage,
  MailRecipients,
} from './message.js'
export { createConsoleProvider } from './providers/console.js'
export type { ConsoleProviderOptions } from './providers/console.js'
export { createMemoryProvider } from './providers/memory.js'
export type { MemoryProvider } from './providers/memory.js'
export { renderMail } from './render.js'
export type { DataOption, RenderedMail, RenderMailOptions } from './render.js'
export { defineLayout, defineTemplate } from './template.js'
export type {
  DataOf,
  LayoutContext,
  LayoutOptions,
  MailFormat,
  MailLayout,
  MailTemplate,
  Source,
  TemplateData,
  TemplateOptions,
  TranslateContext,
} from './template.js'
