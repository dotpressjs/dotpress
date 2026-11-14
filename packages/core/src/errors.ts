const HTTP_ERROR_BRAND = Symbol.for('dotpress.HttpError')

export type ErrorData = Record<string, unknown>

/**
 * JSON body of every error response.
 */
export interface ErrorBody {
  status: number
  error: string
  message: string
  data?: ErrorData
}

export interface HttpErrorOptions {
  /** Details of the error, sent in the `data` field of the response body. */
  data?: ErrorData | undefined
  /** The error that caused this one (`Error.cause`). Never sent. */
  cause?: unknown
}

const OPTIONS: ReadonlySet<string> = new Set(['data', 'cause'])

/**
 * An HTTP error. It can be returned or thrown from middlewares and handlers:
 * both produce the same response.
 *
 * @example
 * new HttpError(402, 'QUOTA_EXCEEDED', 'Quota exceeded', { data: { limit } })
 */
export class HttpError extends Error {
  readonly [HTTP_ERROR_BRAND] = true

  readonly status: number
  readonly code: string
  readonly data: ErrorData | undefined

  constructor(
    status: number,
    code: string,
    message: string,
    options: HttpErrorOptions = {}
  ) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('HttpError options must be an object.')
    }
    for (const key of Object.keys(options)) {
      if (!OPTIONS.has(key)) {
        throw new TypeError(`HttpError: unknown option "${key}".`)
      }
    }

    super(message, 'cause' in options ? { cause: options.cause } : undefined)

    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(
        `HttpError status must be an integer between 400 and 599, received ${status}.`
      )
    }

    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.data = options.data
  }

  toJSON(): ErrorBody {
    return toErrorBody(this)
  }
}

/**
 * Checks whether a value is an `HttpError`, including instances created by
 * another copy of `@dotpress/core`.
 */
export const isHttpError = (value: unknown): value is HttpError =>
  value instanceof HttpError ||
  (typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[HTTP_ERROR_BRAND] === true)

/** The JSON body of the response of an error. */
export const toErrorBody = (error: HttpError): ErrorBody => {
  const body: ErrorBody = {
    status: error.status,
    error: error.code,
    message: error.message,
  }

  if (error.data !== undefined) {
    body.data = error.data
  }

  return body
}

/** An error of any status and code. Same as `new HttpError()`. */
export const errorResponse = (
  status: number,
  code: string,
  message: string,
  options?: HttpErrorOptions
): HttpError => new HttpError(status, code, message, options)

export const badRequestError = (
  message = 'Bad Request',
  options?: HttpErrorOptions
) => errorResponse(400, 'BAD_REQUEST', message, options)

export const unauthorizedError = (
  message = 'Unauthorized',
  options?: HttpErrorOptions
) => errorResponse(401, 'UNAUTHORIZED', message, options)

export const forbiddenError = (
  message = 'Forbidden',
  options?: HttpErrorOptions
) => errorResponse(403, 'FORBIDDEN', message, options)

export const notFoundError = (
  message = 'Not Found',
  options?: HttpErrorOptions
) => errorResponse(404, 'NOT_FOUND', message, options)

export const conflictError = (
  message = 'Conflict',
  options?: HttpErrorOptions
) => errorResponse(409, 'CONFLICT', message, options)

export const unprocessableError = (
  message = 'Unprocessable Entity',
  options?: HttpErrorOptions
) => errorResponse(422, 'UNPROCESSABLE_ENTITY', message, options)

export const tooManyRequestsError = (
  message = 'Too Many Requests',
  options?: HttpErrorOptions
) => errorResponse(429, 'TOO_MANY_REQUESTS', message, options)

export const internalError = (
  message = 'Internal Server Error',
  options?: HttpErrorOptions
) => errorResponse(500, 'INTERNAL_ERROR', message, options)

/**
 * Error used by adapters when the request body cannot be parsed.
 */
export const malformedBodyError = (
  message = 'Malformed request body',
  options?: HttpErrorOptions
) => errorResponse(400, 'MALFORMED_BODY', message, options)

/**
 * Error used by adapters when the request body exceeds their size limit.
 */
export const payloadTooLargeError = (
  message = 'Request body too large',
  options?: HttpErrorOptions
) => errorResponse(413, 'PAYLOAD_TOO_LARGE', message, options)

/**
 * Error used by adapters for unsupported body encodings or charsets.
 */
export const unsupportedMediaTypeError = (
  message = 'Unsupported Media Type',
  options?: HttpErrorOptions
) => errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', message, options)

/**
 * Error returned when the path exists, but not for the request method. The
 * response also carries an `Allow` header.
 */
export const methodNotAllowedError = () =>
  errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')

/**
 * Error returned when no route matches the request.
 */
export const routeNotFoundError = () =>
  errorResponse(404, 'NOT_FOUND', 'Route not found')

/**
 * A single request validation issue.
 */
export interface ValidationIssue {
  source: 'params' | 'query' | 'body' | 'files'
  path: (string | number)[]
  code: string
  message: string
}

export const validationError = (issues: ValidationIssue[]) =>
  errorResponse(400, 'VALIDATION_FAILED', 'Validation failed', {
    data: { issues },
  })
