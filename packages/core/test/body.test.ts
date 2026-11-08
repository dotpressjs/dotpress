import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BODY_LIMIT,
  isHttpError,
  parseQueryString,
  parseRequestBody,
} from '../src/index.js'

const bytes = (value: string) => new TextEncoder().encode(value)

const parse = async (body: Uint8Array, contentType: string | undefined) =>
  (await parseRequestBody(body, contentType)).body

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    if (isHttpError(error)) return { status: error.status, code: error.code }
    throw error
  }
  throw new Error('Expected an HttpError')
}

/** Encodes a form as a multipart body, like a browser does. */
const multipart = async (form: FormData) => {
  const request = new Request('http://localhost', {
    method: 'POST',
    body: form,
  })
  return {
    body: new Uint8Array(await request.arrayBuffer()),
    contentType: request.headers.get('content-type')!,
  }
}

describe('parseQueryString()', () => {
  it('parses single and repeated values', () => {
    expect(parseQueryString('?a=1&b=x&b=y&c=hello+world&d=%C3%A9')).toEqual({
      a: '1',
      b: ['x', 'y'],
      c: 'hello world',
      d: 'é',
    })
    expect(parseQueryString('')).toEqual({})
  })

  it('keeps __proto__ as a regular key', () => {
    const query = parseQueryString('__proto__=a&__proto__=b')

    expect(Object.getPrototypeOf(query)).toBe(Object.prototype)
    expect(Object.hasOwn(query, '__proto__')).toBe(true)
  })
})

describe('parseRequestBody()', () => {
  it('returns undefined for empty bodies', async () => {
    expect(
      await parseRequestBody(new Uint8Array(), 'application/json')
    ).toEqual({ body: undefined, files: undefined })
  })

  it('parses JSON bodies', async () => {
    expect(await parse(bytes('{"a":[1,"é"]}'), 'application/json')).toEqual({
      a: [1, 'é'],
    })
    expect(
      await parse(
        bytes('{"ok":true}'),
        'Application/Vnd.Api+JSON; charset=UTF-8'
      )
    ).toEqual({ ok: true })
    expect(await parse(bytes('null'), 'application/json')).toBeNull()
  })

  it('rejects malformed JSON and invalid UTF-8', async () => {
    expect(
      await errorOf(parseRequestBody(bytes('{oops'), 'application/json'))
    ).toEqual({ status: 400, code: 'MALFORMED_BODY' })
    expect(
      await errorOf(
        parseRequestBody(new Uint8Array([0x22, 0xff, 0x22]), 'application/json')
      )
    ).toEqual({ status: 400, code: 'MALFORMED_BODY' })
  })

  it('parses URL-encoded forms', async () => {
    expect(
      await parse(
        bytes('name=Ada+Lovelace&tag=a&tag=b'),
        'application/x-www-form-urlencoded'
      )
    ).toEqual({ name: 'Ada Lovelace', tag: ['a', 'b'] })
  })

  it('parses multipart forms into fields and files', async () => {
    const form = new FormData()
    form.append('title', 'Holidays')
    form.append('tag', 'sea')
    form.append('tag', 'sun')
    form.append(
      'cover',
      new File([new Uint8Array([0, 1, 255])], 'cover.png', {
        type: 'image/png',
      })
    )
    form.append('photos', new File(['a'], 'a.jpg', { type: 'image/jpeg' }))
    form.append('photos', new File(['b'], 'b.jpg', { type: 'image/jpeg' }))

    const { body, contentType } = await multipart(form)
    const parsed = await parseRequestBody(body, contentType)

    expect(parsed.body).toEqual({ title: 'Holidays', tag: ['sea', 'sun'] })

    const cover = parsed.files?.cover as File
    expect(cover).toBeInstanceOf(File)
    expect(cover).toMatchObject({ name: 'cover.png', type: 'image/png' })
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 255])
    )

    const photos = parsed.files?.photos as File[]
    expect(photos.map((photo) => photo.name)).toEqual(['a.jpg', 'b.jpg'])
  })

  it('keeps __proto__ as a regular multipart field', async () => {
    const form = new FormData()
    form.append('__proto__', 'x')
    form.append('__proto__', new File(['a'], 'a.txt'))

    const { body, contentType } = await multipart(form)
    const parsed = await parseRequestBody(body, contentType)

    expect(Object.getPrototypeOf(parsed.body)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(parsed.files)).toBe(Object.prototype)
    expect(Object.hasOwn(parsed.files!, '__proto__')).toBe(true)
  })

  it('rejects malformed multipart bodies', async () => {
    expect(
      await errorOf(
        parseRequestBody(bytes('garbage'), 'multipart/form-data; boundary=xyz')
      )
    ).toEqual({ status: 400, code: 'MALFORMED_BODY' })
    expect(
      await errorOf(parseRequestBody(bytes('garbage'), 'multipart/form-data'))
    ).toEqual({ status: 400, code: 'MALFORMED_BODY' })
  })

  it('decodes text bodies with their charset', async () => {
    expect(await parse(bytes('héllo'), 'text/plain')).toBe('héllo')
    expect(
      await parse(new Uint8Array([0x68, 0xe9]), 'text/plain; charset="latin1"')
    ).toBe('hé')
    expect(
      await errorOf(parseRequestBody(bytes('x'), 'text/plain; charset=klingon'))
    ).toEqual({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
  })

  it('returns the raw bytes for other content types', async () => {
    const payload = new Uint8Array([1, 2, 3])
    expect(await parse(payload, 'application/octet-stream')).toBe(payload)
    expect(await parse(payload, undefined)).toBe(payload)
  })

  it('exposes the default body limit', () => {
    expect(DEFAULT_BODY_LIMIT).toBe(1_048_576)
  })
})
