import { describe, expect, it } from 'vitest'
import { createRouter, type Middleware } from '../src/index.js'
import { createTestApp } from './support/memory-adapter.js'

const png = (size: number, name = 'avatar.png') =>
  new File([new Uint8Array(size)], name, { type: 'image/png' })

const formWith = (entries: [string, string | File][]) => {
  const form = new FormData()
  for (const [name, value] of entries) form.append(name, value)
  return form
}

describe('uploads', () => {
  const avatarRoute = createTestApp((router) => {
    router.defineRoute({
      method: 'post',
      path: '/avatar',
      schema: (z) => ({
        body: z.object({ caption: z.string().optional() }),
        files: z.object({
          avatar: z.file().max(100).mime(['image/png', 'image/jpeg']),
        }),
      }),
      handler: async ({ req }) => ({
        name: req.files.avatar.name,
        size: req.files.avatar.size,
        type: req.files.avatar.type,
        caption: req.body.caption,
      }),
    })
  })

  it('gives handlers the validated files and fields', async () => {
    const { inject } = await avatarRoute

    const res = await inject({
      method: 'post',
      url: '/avatar',
      formData: formWith([
        ['caption', 'Me'],
        ['avatar', png(10)],
      ]),
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      name: 'avatar.png',
      size: 10,
      type: 'image/png',
      caption: 'Me',
    })
  })

  it('returns VALIDATION_FAILED issues for invalid files', async () => {
    const { inject } = await avatarRoute

    const tooLarge = await inject({
      method: 'post',
      url: '/avatar',
      formData: formWith([
        [
          'avatar',
          new File([new Uint8Array(101)], 'a.gif', { type: 'image/gif' }),
        ],
      ]),
    })

    expect(tooLarge.status).toBe(400)
    expect(tooLarge.body).toMatchObject({
      error: 'VALIDATION_FAILED',
      data: {
        issues: [
          { source: 'files', path: ['avatar'], code: 'too_big' },
          { source: 'files', path: ['avatar'], code: 'invalid_value' },
        ],
      },
    })

    const missing = await inject({
      method: 'post',
      url: '/avatar',
      formData: formWith([['caption', 'No file']]),
    })

    expect(missing.body).toMatchObject({
      data: {
        issues: [{ source: 'files', path: ['avatar'], code: 'invalid_type' }],
      },
    })
  })

  it('validates repeated file fields as arrays', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/photos',
        schema: (z) => ({
          files: z.object({
            photos: z
              .union([z.file(), z.array(z.file())])
              .transform((value) => [value].flat())
              .pipe(z.array(z.file()).max(2)),
          }),
        }),
        handler: ({ req }) => req.files.photos.map((photo) => photo.name),
      })
    })

    const one = await inject({
      method: 'post',
      url: '/photos',
      formData: formWith([['photos', png(1, 'a.png')]]),
    })
    expect(one.body).toEqual(['a.png'])

    const two = await inject({
      method: 'post',
      url: '/photos',
      formData: formWith([
        ['photos', png(1, 'a.png')],
        ['photos', png(1, 'b.png')],
      ]),
    })
    expect(two.body).toEqual(['a.png', 'b.png'])

    const three = await inject({
      method: 'post',
      url: '/photos',
      formData: formWith([
        ['photos', png(1, 'a.png')],
        ['photos', png(1, 'b.png')],
        ['photos', png(1, 'c.png')],
      ]),
    })
    expect(three.status).toBe(400)
  })

  it('exposes unvalidated files to middlewares and schema-less routes', async () => {
    const seen: string[] = []
    const inspect: Middleware = ({ req }) => {
      seen.push(...Object.keys(req.files))
    }

    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/raw',
        middlewares: [inspect],
        handler: ({ req }) => ({
          files: Object.keys(req.files),
          isFile: req.files.doc instanceof File,
        }),
      })
    })

    const res = await inject({
      method: 'post',
      url: '/raw',
      formData: formWith([['doc', new File(['x'], 'doc.txt')]]),
    })

    expect(res.body).toEqual({ files: ['doc'], isFile: true })
    expect(seen).toEqual(['doc'])
  })

  it('gives an empty files object for other requests', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/json',
        handler: ({ req }) => ({ files: req.files }),
      })
    })

    expect(
      (await inject({ method: 'post', url: '/json', body: { a: 1 } })).body
    ).toEqual({ files: {} })
  })
})

describe('bodyLimit route option', () => {
  it('is exposed in the route introspection data', async () => {
    const { app } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/upload',
        bodyLimit: 10 * 1024 * 1024,
        handler: () => null,
      })
      router.defineRoute({ path: '/other', handler: () => null })
    })

    expect(app.routes.map((route) => route.bodyLimit)).toEqual([
      10 * 1024 * 1024,
      undefined,
    ])
  })

  it('rejects invalid values', () => {
    const router = createRouter()

    expect(() =>
      router.defineRoute({ path: '/a', bodyLimit: -1, handler: () => null })
    ).toThrow('bodyLimit must be a non-negative integer')
    expect(() =>
      router.defineRoute({ path: '/b', bodyLimit: 1.5, handler: () => null })
    ).toThrow('bodyLimit must be a non-negative integer')
  })
})
