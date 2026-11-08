import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'
import * as zm from 'zod/mini'
import { arrayOf } from '../src/index.js'
import { createTestApp } from './support/memory-adapter.js'

const png = (name: string) => new File(['x'], name, { type: 'image/png' })

describe('arrayOf()', () => {
  it('wraps single values and keeps arrays', () => {
    const schema = arrayOf(z.string())

    expect(schema.parse('a')).toEqual(['a'])
    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b'])
    expect(schema.safeParse(undefined).success).toBe(false)
    expectTypeOf(schema.parse('a')).toEqualTypeOf<string[]>()
  })

  it('applies the constraints of an array schema', () => {
    const schema = arrayOf(z.array(z.coerce.number()).min(1).max(2))

    expect(schema.parse('3')).toEqual([3])
    expect(schema.safeParse([]).error?.issues[0]?.code).toBe('too_small')
    expect(schema.safeParse(['1', '2', '3']).error?.issues[0]?.code).toBe(
      'too_big'
    )
    expectTypeOf(schema.parse('3')).toEqualTypeOf<number[]>()
  })

  it('supports Zod mini schemas', () => {
    const schema = arrayOf(zm.array(zm.string()).check(zm.maxLength(1)))

    expect(schema.parse('a')).toEqual(['a'])
    expect(schema.safeParse(['a', 'b']).success).toBe(false)
    expect(arrayOf(zm.string()).parse('a')).toEqual(['a'])
  })

  it('supports optional and default values', () => {
    expect(arrayOf(z.string()).optional().parse(undefined)).toBeUndefined()
    expect(arrayOf(z.string()).default([]).parse(undefined)).toEqual([])
  })

  it('reports element issues with their index', () => {
    const result = z
      .object({ ids: arrayOf(z.uuid()) })
      .safeParse({ ids: [crypto.randomUUID(), 'nope'] })

    expect(result.error?.issues[0]?.path).toEqual(['ids', 1])
  })

  it('validates repeated query values', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        path: '/search',
        schema: (z) => ({
          query: z.object({ tag: arrayOf(z.string()).default([]) }),
        }),
        handler: ({ req }) => {
          expectTypeOf(req.query.tag).toEqualTypeOf<string[]>()
          return req.query.tag
        },
      })
    })

    expect((await inject({ url: '/search' })).body).toEqual([])
    expect((await inject({ url: '/search?tag=a' })).body).toEqual(['a'])
    expect((await inject({ url: '/search?tag=a&tag=b' })).body).toEqual([
      'a',
      'b',
    ])
  })

  it('validates repeated file fields', async () => {
    const { inject } = await createTestApp((router) => {
      router.defineRoute({
        method: 'post',
        path: '/photos',
        schema: (z) => ({
          files: z.object({
            photos: arrayOf(z.array(z.file().mime(['image/png'])).max(2)),
          }),
        }),
        handler: ({ req }) => {
          expectTypeOf(req.files.photos).toEqualTypeOf<File[]>()
          return req.files.photos.map((photo) => photo.name)
        },
      })
    })

    const send = (...files: File[]) => {
      const form = new FormData()
      for (const file of files) form.append('photos', file)
      return inject({ method: 'post', url: '/photos', formData: form })
    }

    expect((await send(png('a.png'))).body).toEqual(['a.png'])
    expect((await send(png('a.png'), png('b.png'))).body).toEqual([
      'a.png',
      'b.png',
    ])

    const tooMany = await send(png('a.png'), png('b.png'), png('c.png'))
    expect(tooMany.status).toBe(400)
    expect(tooMany.body).toMatchObject({
      data: {
        issues: [{ source: 'files', path: ['photos'], code: 'too_big' }],
      },
    })
  })
})
