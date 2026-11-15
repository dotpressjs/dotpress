import { describe, expect, it } from 'vitest'
import {
  empty,
  file,
  json,
  notFoundError,
  redirect,
  stream,
  text,
} from '../src/index.js'
import { createTestApp } from './support/memory-adapter.js'

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      controller.close()
    },
  })

describe('responses', () => {
  describe('status', () => {
    it('returns 204 without body when the handler returns nothing', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          method: 'delete',
          path: '/item',
          handler: () => {},
        })
      })

      const res = await inject({ method: 'delete', url: '/item' })

      expect(res.status).toBe(204)
      expect(res.response.body).toBeNull()
      expect(res.text).toBeUndefined()
    })

    it('uses the route status, overridden by ctx.res.setStatus()', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          method: 'post',
          path: '/created',
          status: 201,
          handler: () => ({ id: 1 }),
        })
        router.defineRoute({
          method: 'post',
          path: '/accepted',
          status: 201,
          handler: ({ res }) => {
            res.setStatus(202)
            return { queued: true }
          },
        })
      })

      expect((await inject({ method: 'post', url: '/created' })).status).toBe(
        201
      )
      expect((await inject({ method: 'post', url: '/accepted' })).status).toBe(
        202
      )
    })

    it('serializes null as JSON', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({ path: '/null', handler: () => null })
      })

      const res = await inject({ url: '/null' })

      expect(res.status).toBe(200)
      expect(res.text).toBe('null')
    })
  })

  describe('response schema', () => {
    it('strips unknown keys', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/me',
          schema: (z) => ({ response: z.object({ id: z.string() }) }),
          handler: () =>
            ({ id: '1', passwordHash: 'secret' }) as { id: string },
        })
      })

      expect((await inject({ url: '/me' })).body).toEqual({ id: '1' })
    })

    it('returns a generic 500 error when the result does not match', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/broken',
          schema: (z) => ({ response: z.object({ id: z.string() }) }),
          handler: () => ({ id: 42 }) as unknown as { id: string },
        })
      })

      const res = await inject({ url: '/broken' })

      expect(res.status).toBe(500)
      expect(res.body).toEqual({
        status: 500,
        error: 'INTERNAL_ERROR',
        message: 'Internal Server Error',
      })
    })

    it('exposes the response issues when exposeErrors is enabled', async () => {
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/broken',
            schema: (z) => ({ response: z.object({ id: z.string() }) }),
            handler: () => ({ id: 42 }) as unknown as { id: string },
          })
        },
        { exposeErrors: true }
      )

      const res = await inject({ url: '/broken' })

      expect(res.body).toMatchObject({
        data: {
          name: 'ResponseValidationError',
          issues: [{ path: ['id'], code: 'invalid_type' }],
        },
      })
    })

    it('enforces z.never() responses', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          method: 'delete',
          path: '/ok',
          schema: (z) => ({ response: z.never() }),
          handler: () => undefined,
        })
        router.defineRoute({
          method: 'delete',
          path: '/broken',
          schema: (z) => ({ response: z.never() }),
          handler: () => ({ unexpected: true }) as never,
        })
      })

      expect((await inject({ method: 'delete', url: '/ok' })).status).toBe(204)
      expect((await inject({ method: 'delete', url: '/broken' })).status).toBe(
        500
      )
    })
  })

  describe('helpers', () => {
    it('json() sets status and headers and still validates the data', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          method: 'post',
          path: '/members',
          schema: (z) => ({ response: z.object({ id: z.string() }) }),
          handler: () =>
            json(
              { id: '1' },
              { status: 201, headers: { location: '/members/1' } }
            ),
        })
      })

      const res = await inject({ method: 'post', url: '/members' })

      expect(res.status).toBe(201)
      expect(res.headers.location).toBe('/members/1')
      expect(res.body).toEqual({ id: '1' })
    })

    it('text() returns plain text', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({ path: '/health', handler: () => text('OK') })
      })

      const res = await inject({ url: '/health' })

      expect(res.status).toBe(200)
      expect(typeof res.response.body).toBe('string')
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(res.text).toBe('OK')
    })

    it('redirect() defaults to 302', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({ path: '/old', handler: () => redirect('/new') })
        router.defineRoute({
          path: '/moved',
          handler: () => redirect('/new', { status: 301 }),
        })
      })

      const temporary = await inject({ url: '/old' })
      const permanent = await inject({ url: '/moved' })

      expect(temporary.status).toBe(302)
      expect(temporary.headers.location).toBe('/new')
      expect(temporary.response.body).toBeNull()
      expect(permanent.status).toBe(301)
    })

    it('redirect() takes headers, and checks its options', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/old',
          handler: () =>
            redirect('/new', {
              status: 308,
              headers: { 'cache-control': 'no-store' },
            }),
        })
      })

      const res = await inject({ url: '/old' })
      expect(res.status).toBe(308)
      expect(res.headers).toMatchObject({
        location: '/new',
        'cache-control': 'no-store',
      })
      expect(() => redirect('/new', 301 as never)).toThrow(
        new TypeError(
          'redirect(): expected an options object, like { status: 301 }.'
        )
      )
      expect(() => redirect('/new', { code: 301 } as never)).toThrow(
        new TypeError('redirect(): unknown option "code".')
      )
      expect(() => redirect('/new', { status: 200 as never })).toThrow(
        new RangeError(
          'redirect(): status must be 301, 302, 303, 307 or 308, received 200.'
        )
      )
    })

    it('stream() returns a stream', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/events',
          handler: () =>
            stream(streamOf('a', 'b'), { contentType: 'text/plain' }),
        })
      })

      const res = await inject({ url: '/events' })

      expect(res.response.body).toBeInstanceOf(ReadableStream)
      expect(res.headers['content-type']).toBe('text/plain')
      expect(res.text).toBe('ab')
    })

    it('file() sets download headers', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/invoice',
          handler: () =>
            file(new TextEncoder().encode('%PDF'), {
              filename: 'facture été.pdf',
              contentType: 'application/pdf',
            }),
        })
        router.defineRoute({
          path: '/blob',
          handler: () =>
            file(new Blob(['hello'], { type: 'text/plain' }), {
              disposition: 'inline',
            }),
        })
      })

      const invoice = await inject({ url: '/invoice' })
      const blob = await inject({ url: '/blob' })

      expect(invoice.headers).toMatchObject({
        'content-type': 'application/pdf',
        'content-length': '4',
        'content-disposition': `attachment; filename="facture _t_.pdf"; filename*=UTF-8''facture%20%C3%A9t%C3%A9.pdf`,
      })
      expect(invoice.text).toBe('%PDF')
      expect(blob.headers).toMatchObject({
        'content-type': 'text/plain',
        'content-length': '5',
        'content-disposition': 'inline',
      })
      expect(blob.text).toBe('hello')
    })

    it('empty() returns no body', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          method: 'post',
          path: '/jobs',
          handler: () => empty({ status: 202 }),
        })
      })

      const res = await inject({ method: 'post', url: '/jobs' })

      expect(res.status).toBe(202)
      expect(res.text).toBeUndefined()
    })
  })

  describe('headers and cookies', () => {
    it('includes headers and cookies set on ctx.res', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/login',
          handler: ({ res }) => {
            res
              .setHeader('Cache-Control', 'no-store')
              .setCookie('session', 'a b', { httpOnly: true, sameSite: 'lax' })
              .setCookie('theme', 'dark')
            return { ok: true }
          },
        })
      })

      const res = await inject({ url: '/login' })

      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['set-cookie']).toEqual([
        'session=a%20b; Path=/; HttpOnly; SameSite=Lax',
        'theme=dark; Path=/',
      ])
    })

    it('keeps them on returned errors', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/logout',
          handler: ({ res }) => {
            res.clearCookie('session')
            return notFoundError()
          },
        })
      })

      const res = await inject({ url: '/logout' })

      expect(res.status).toBe(404)
      expect(res.headers['set-cookie']).toEqual([
        'session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
      ])
    })

    it('drops them on unexpected errors', async () => {
      const { inject } = await createTestApp((router) => {
        router.defineRoute({
          path: '/crash',
          handler: ({ res }) => {
            res.setCookie('session', 'x')
            throw new Error('boom')
          },
        })
      })

      const res = await inject({ url: '/crash' })

      expect(res.status).toBe(500)
      expect(res.headers['set-cookie']).toBeUndefined()
    })

    it('sends the request id', async () => {
      let seen: string | undefined
      const { inject } = await createTestApp(
        (router) => {
          router.defineRoute({
            path: '/id',
            handler: ({ requestId }) => {
              seen = requestId
              return null
            },
          })
        },
        {
          // A DotpressRequest: header() ignores the letter case.
          generateRequestId: (req) => req.header('X-Request-ID') ?? 'generated',
        }
      )

      const res = await inject({
        url: '/id',
        headers: { 'X-Request-ID': 'abc' },
      })

      expect(seen).toBe('abc')
      expect(res.headers['x-request-id']).toBe('abc')
    })
  })
})
