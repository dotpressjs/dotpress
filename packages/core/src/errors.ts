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
  cause?: unknown
}

/**
 * An HTTP error. It can be returned or thrown from middlewares and handlers:
 * both produce the same response.
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
    data?: ErrorData,
    options?: HttpErrorOptions
  ) {
    super(message, options)

    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(
        `HttpError status must be an integer between 400 and 599, received ${status}.`
      )
    }

    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.data = data
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

export const errorResponse = (
  status: number,
  code: string,
  message: string,
  data?: ErrorData
): HttpError => new HttpError(status, code, message, data)

export const badRequestError = (message = 'Bad Request', data?: ErrorData) =>
  errorResponse(400, 'BAD_REQUEST', message, data)

export const unauthorizedError = (message = 'Unauthorized', data?: ErrorData) =>
  errorResponse(401, 'UNAUTHORIZED', message, data)

export const forbiddenError = (message = 'Forbidden', data?: ErrorData) =>
  errorResponse(403, 'FORBIDDEN', message, data)

export const notFoundError = (message = 'Not Found', data?: ErrorData) =>
  errorResponse(404, 'NOT_FOUND', message, data)

export const conflictError = (message = 'Conflict', data?: ErrorData) =>
  errorResponse(409, 'CONFLICT', message, data)

export const unprocessableError = (
  message = 'Unprocessable Entity',
  data?: ErrorData
) => errorResponse(422, 'UNPROCESSABLE_ENTITY', message, data)

export const tooManyRequestsError = (
  message = 'Too Many Requests',
  data?: ErrorData
) => errorResponse(429, 'TOO_MANY_REQUESTS', message, data)

export const internalError = (
  message = 'Internal Server Error',
  data?: ErrorData
) => errorResponse(500, 'INTERNAL_ERROR', message, data)

/**
 * Error used by adapters when the request body cannot be parsed.
 */
export const malformedBodyError = (message = 'Malformed request body') =>
  errorResponse(400, 'MALFORMED_BODY', message)

/**
 * Error used by adapters when the request body exceeds their size limit.
 */
export const payloadTooLargeError = (message = 'Request body too large') =>
  errorResponse(413, 'PAYLOAD_TOO_LARGE', message)

/**
 * Error used by adapters for unsupported body encodings or charsets.
 */
export const unsupportedMediaTypeError = (message = 'Unsupported Media Type') =>
  errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', message)

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
  source: 'params' | 'query' | 'body'
  path: (string | number)[]
  code: string
  message: string
}

export const validationError = (issues: ValidationIssue[]) =>
  errorResponse(400, 'VALIDATION_FAILED', 'Validation failed', { issues })
