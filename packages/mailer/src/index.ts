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
  MailerContext,
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
  MailAttachmentInput,
  MailMessage,
  MailRecipients,
} from './message.js'
export { createConsoleProvider } from './providers/console.js'
export type { ConsoleProviderOptions } from './providers/console.js'
export { createMemoryProvider } from './providers/memory.js'
export type { HttpProviderOptions } from './providers/http.js'
export type { MemoryProvider } from './providers/memory.js'
export { renderMail } from './render.js'
export type { RenderedMail, RenderMailOptions } from './render.js'
export { defineLayout, defineTemplate } from './template.js'
export type {
  LayoutContext,
  LayoutOptions,
  MailFormat,
  MailLayout,
  MailTemplate,
  TemplateData,
  TemplateOptions,
  TemplateSource,
  TranslateContext,
} from './template.js'
