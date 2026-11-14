import { afterEach, describe, expect, it } from 'vitest'
import { base64 } from '../src/encoding.js'

const CHUNK = 0x8000

/** Bytes that are not all the same, so that a shifted chunk shows. */
const bytesOf = (length: number) =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 255)

const expected = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

const prototype = Uint8Array.prototype as { toBase64?: unknown }
const nativeToBase64 = Object.getOwnPropertyDescriptor(prototype, 'toBase64')

describe('base64', () => {
  afterEach(() => {
    if (nativeToBase64)
      Object.defineProperty(prototype, 'toBase64', nativeToBase64)
  })

  const lengths = [0, 1, 2, 3, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 5]

  it.each(lengths)('encodes %i bytes with btoa', (length) => {
    // The fallback, whatever the runtime running the tests.
    delete prototype.toBase64
    const bytes = bytesOf(length)
    expect(base64(bytes)).toBe(expected(bytes))
  })

  it.each(lengths)('encodes %i bytes with the runtime', (length) => {
    const bytes = bytesOf(length)
    expect(base64(bytes)).toBe(expected(bytes))
  })

  it('encodes every byte value', () => {
    delete prototype.toBase64
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
    expect(base64(bytes)).toBe(expected(bytes))
  })

  it('encodes the UTF-8 bytes of a string', () => {
    delete prototype.toBase64
    expect(base64('Café ☕')).toBe(Buffer.from('Café ☕').toString('base64'))
  })

  it('uses Uint8Array#toBase64 when the runtime has it', () => {
    const bytes = Object.assign(new Uint8Array([1, 2, 3]), {
      toBase64: () => 'native',
    })
    expect(base64(bytes)).toBe('native')
  })
})
