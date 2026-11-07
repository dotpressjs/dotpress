import { describe, expect, it, vi } from 'vitest'
import {
  HttpError,
  badRequestError,
  conflictError,
  errorResponse,
  forbiddenError,
  internalError,
  isHttpError,
  notFoundError,
  tooManyRequestsError,
  unauthorizedError,
  unprocessableError,
} from '../src/index.js'
import { createTestApp, silentLogger } from './support/memory-adapter.js'

describe('errors', () => {
  it.each([
    [badRequestError, 400, 'BAD_REQUEST', 'Bad Request'],
    [unauthorizedError, 401, 'UNAUTHORIZED', 'Unauthorized'],
    [forbiddenError, 403, 'FORBIDDEN', 'Forbidden'],
    [notFoundError, 404, 'NOT_FOUND', 'Not Found'],
    [conflictError, 409, 'CONFLICT', 'Conflict'],
    [unprocessableError, 422, 'UNPROCESSABLE_ENTITY', 'Unprocessable Entity'],
    [tooManyRequestsError, 429, 'TOO_MANY_REQUESTS', 'Too Many Requests'],
    [internalError, 500, 'INTERNAL_ERROR', 'Internal Server Error'],
  ] as const)('%o creates a %i error', (create, status, code, message) => {
    const error = create()

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status, code, message, data: undefined })
    expect(create('Custom', { field: 'x' })).toMatchObject({
      message: 'Custom',
      data: { field: 'x' },
    })
  })

  it('rejects statuses that are not errors', () => {
    expect(() => errorResponse(200, 'OK', 'Not an error')).toThrow(RangeError)
    expect(() => errorResponse(600, 'NOPE', 'Out of range')).toThrow(RangeError)
  })

  it('serializes to the standard error body', () => {
    expect(
      JSON.parse(JSON.stringify(conflictError('Taken', { id: 1 })))
    ).toEqual({
      status: 409,
      error: 'CONFLICT',
      message: 'Taken',
      data: { id: 1 },
    })
  })

  it('recognizes errors created by another copy of the package', () => {
    const foreign = Object.assign(new Error('x'), {
      [Symbol.for('dotpress.HttpError')]: true,
    })

    expect(isHttpError(foreign)).toBe(true)
    expect(isHttpError(new Error('x'))).toBe(false)
    expect(isHttpError(null)).toBe(false)
  })

  describe('in the pipeline', () => {
    it('produces the same response for returned and thrown errors', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/returned',
          handler: () => notFoundError('Member not found', { id: '1' }),
        })
        router.defineRoute({
          path: '/thrown',
          handler: () => {
            throw notFoundError('Member not found', { id: '1' })
          },
        })
      })

      const returned = await inject({ url: '/returned' })
      const thrown = await inject({ url: '/thrown' })

      expect(returned.status).toBe(404)
      expect(returned.body).toEqual({
        status: 404,
        error: 'NOT_FOUND',
        message: 'Member not found',
        data: { id: '1' },
      })
      expect(thrown.status).toBe(returned.status)
      expect(thrown.body).toEqual(returned.body)
    })

    it('turns unexpected errors into a generic 500, logs them and calls onError', async () => {
      const logger = silentLogger()
      const onError = vi.fn()
      const failure = new Error('Database is down')

      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/crash',
            handler: () => {
              throw failure
            },
          })
        },
        { logger, onError }
      )

      const res = await inject({ url: '/crash' })

      expect(res.status).toBe(500)
      expect(res.body).toEqual({
        status: 500,
        error: 'INTERNAL_ERROR',
        message: 'Internal Server Error',
      })
      expect(onError).toHaveBeenCalledWith(
        failure,
        expect.objectContaining({ requestId: res.headers['x-request-id'] })
      )
      expect(logger.entries).toContainEqual({
        level: 'error',
        args: [failure, 'Unhandled error while processing request'],
      })
    })

    it('survives a failing onError hook', async () => {
      const logger = silentLogger()
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/crash',
            handler: () => {
              throw new Error('boom')
            },
          })
        },
        {
          logger,
          onError: () => {
            throw new Error('Sentry is down')
          },
        }
      )

      const res = await inject({ url: '/crash' })

      expect(res.status).toBe(500)
      expect(logger.entries.map((entry) => entry.args[1])).toContain(
        'onError hook failed'
      )
    })

    it('exposes error details when exposeErrors is enabled', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/crash',
            handler: () => {
              throw new TypeError('Cannot read properties of undefined')
            },
          })
        },
        { exposeErrors: true }
      )

      const res = await inject({ url: '/crash' })

      expect(res.body).toMatchObject({
        status: 500,
        data: {
          name: 'TypeError',
          message: 'Cannot read properties of undefined',
          stack: expect.stringContaining('TypeError'),
        },
      })
    })

    it('handles adapter errors through the runtime', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          method: 'post',
          path: '/items',
          handler: () => null,
        })
      })

      const res = await inject({
        method: 'post',
        url: '/items',
        rawBody: '{oops',
      })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({
        status: 400,
        error: 'MALFORMED_BODY',
        message: 'Malformed request body',
      })
      expect(res.headers['x-request-id']).toEqual(expect.any(String))
    })

    it('falls back to a random request id when the generator throws', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({ path: '/', handler: () => null })
        },
        {
          generateRequestId: () => {
            throw new Error('no id')
          },
        }
      )

      const res = await inject({ url: '/' })

      expect(res.status).toBe(500)
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    })
  })
})
