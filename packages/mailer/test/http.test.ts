import { describe, expect, it } from 'vitest'
import { MailMessageError } from '../src/index.js'
import { jsonBody } from '../src/providers/http.js'

describe('jsonBody()', () => {
  it('accepts a body of exactly the maximum size', () => {
    // {"a":"x"}: 9 bytes.
    expect(jsonBody('API', { a: 'x' }, 9)).toBe('{"a":"x"}')
  })

  it('counts bytes, not characters', () => {
    // {"a":"é"}: 9 characters, 10 bytes.
    expect(() => jsonBody('API', { a: 'é' }, 9)).toThrow(
      new MailMessageError(
        'API accepts requests of at most 0.000009 MB, got 0.0 MB (attachments are base64-encoded).'
      )
    )
  })
})
