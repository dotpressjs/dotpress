/** Base class of the errors thrown by `@dotpress/mailer`. */
export class MailerError extends Error {
  override name = 'MailerError'
}

/** Problem found in the data passed to a template. */
export interface MailDataIssue {
  /** Path of the invalid value, empty for the data itself. */
  readonly path: readonly (string | number)[]
  readonly message: string
}

/** The data passed to a template does not match its schema. */
export class MailDataError extends MailerError {
  override name = 'MailDataError'

  constructor(
    /** Name of the template. */
    readonly template: string,
    readonly issues: readonly MailDataIssue[]
  ) {
    const details = issues
      .map(({ path, message }) =>
        path.length > 0 ? `${path.join('.')}: ${message}` : message
      )
      .join('; ')
    super(`Invalid data for mail template "${template}": ${details}`)
  }
}

/** A template could not be rendered (MJML, translations, Mustache). */
export class MailRenderError extends MailerError {
  override name = 'MailRenderError'

  constructor(
    /** Name of the template. */
    readonly template: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(`Cannot render mail template "${template}": ${message}`, options)
  }
}
