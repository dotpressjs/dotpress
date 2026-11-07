import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BODY_LIMIT,
  isHttpError,
  parseQueryString,
  parseRequestBody,
} from '../src/index.js'

const bytes = (value: string) => new TextEncoder().encode(value)

const errorOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    if (isHttpError(error)) return { status: error.status, code: error.code }
    throw error
  }
  throw new Error('Expected an HttpError')
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
})

describe('parseRequestBody()', () => {
  it('returns undefined for empty bodies', () => {
    expect(parseRequestBody(new Uint8Array(), 'application/json')).toBe(
      undefined
    )
  })

  it('parses JSON bodies', () => {
    expect(
      parseRequestBody(bytes('{"a":[1,"é"]}'), 'application/json')
    ).toEqual({ a: [1, 'é'] })
    expect(
      parseRequestBody(
        bytes('{"ok":true}'),
        'Application/Vnd.Api+JSON; charset=UTF-8'
      )
    ).toEqual({ ok: true })
    expect(parseRequestBody(bytes('null'), 'application/json')).toBeNull()
  })

  it('rejects malformed JSON and invalid UTF-8', () => {
    expect(
      errorOf(() => parseRequestBody(bytes('{oops'), 'application/json'))
    ).toEqual({ status: 400, code: 'MALFORMED_BODY' })
    expect(
      errorOf(() =>
        parseRequestBody(new Uint8Array([0x22, 0xff, 0x22]), 'application/json')
      )
    ).toEqual({ status: 400, code: 'MALFORMED_BODY' })
  })

  it('parses URL-encoded forms', () => {
    expect(
      parseRequestBody(
        bytes('name=Ada+Lovelace&tag=a&tag=b'),
        'application/x-www-form-urlencoded'
      )
    ).toEqual({ name: 'Ada Lovelace', tag: ['a', 'b'] })
  })

  it('decodes text bodies with their charset', () => {
    expect(parseRequestBody(bytes('héllo'), 'text/plain')).toBe('héllo')
    expect(
      parseRequestBody(
        new Uint8Array([0x68, 0xe9]),
        'text/plain; charset="latin1"'
      )
    ).toBe('hé')
    expect(
      errorOf(() => parseRequestBody(bytes('x'), 'text/plain; charset=klingon'))
    ).toEqual({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
  })

  it('returns the raw bytes for other content types', () => {
    const payload = new Uint8Array([1, 2, 3])
    expect(parseRequestBody(payload, 'application/octet-stream')).toBe(payload)
    expect(parseRequestBody(payload, undefined)).toBe(payload)
  })

  it('exposes the default body limit', () => {
    expect(DEFAULT_BODY_LIMIT).toBe(1_048_576)
  })
})
