import { describe, expect, it } from 'vitest'
import { parseEnvelope } from '../src/index.js'
import { messageId } from '../src/envelope.js'
import { envelopeOf } from './support.js'

describe('messageId()', () => {
  it('derives a stable UUID (version 8) from the emission and the listener', async () => {
    const id = await messageId('emission-1', 'send-welcome-mail')
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(await messageId('emission-1', 'send-welcome-mail')).toBe(id)
    expect(await messageId('emission-1', 'geocode')).not.toBe(id)
    expect(await messageId('emission-2', 'send-welcome-mail')).not.toBe(id)
    // The separator keeps "a" + "bc" apart from "ab" + "c".
    expect(await messageId('a', 'bc')).not.toBe(await messageId('ab', 'c'))
  })

  it('is the SHA-256 of both, formatted as a UUID', async () => {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode('emission-1\nsend-welcome-mail')
      )
    )
    const hex = Buffer.from(digest.slice(0, 16)).toString('hex')
    const id = (await messageId('emission-1', 'send-welcome-mail')).replaceAll(
      '-',
      ''
    )
    // Same bytes, but the version and variant bits.
    expect(id.slice(0, 12)).toBe(hex.slice(0, 12))
    expect(id[12]).toBe('8')
    expect(id.slice(13, 16)).toBe(hex.slice(13, 16))
    expect(id.slice(17)).toBe(hex.slice(17))
    expect((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toBe(
      parseInt(id[16] as string, 16)
    )
  })
})

describe('parseEnvelope()', () => {
  it('accepts an envelope, or its JSON', () => {
    const envelope = envelopeOf()
    expect(parseEnvelope(envelope)).toEqual({ envelope })
    expect(parseEnvelope(JSON.stringify(envelope))).toEqual({ envelope })
    expect(parseEnvelope(envelopeOf({ payload: null }))).toEqual({
      envelope: envelopeOf({ payload: null }),
    })
  })

  it.each([
    ['text that is not JSON', 'hello', 'the message is not JSON'],
    ['an array', [], 'the message is not an object'],
    ['null', null, 'the message is not an object'],
    ['JSON of a number', '42', 'the message is not an object'],
    [
      'another version',
      envelopeOf({ v: 2 as never }),
      'unsupported envelope version 2',
    ],
    [
      'no version',
      { ...envelopeOf(), v: undefined },
      'unsupported envelope version undefined',
    ],
    ['no id', envelopeOf({ id: '' }), 'the envelope has no id'],
    [
      'no emission',
      envelopeOf({ emissionId: 1 as never }),
      'the envelope has no emissionId',
    ],
    [
      'no event',
      envelopeOf({ event: undefined as never }),
      'the envelope has no event',
    ],
    [
      'no listener',
      envelopeOf({ listener: '' }),
      'the envelope has no listener',
    ],
    ['no date', envelopeOf({ emittedAt: '' }), 'the envelope has no emittedAt'],
    [
      'no payload',
      Object.fromEntries(
        Object.entries(envelopeOf()).filter(([key]) => key !== 'payload')
      ),
      'the envelope has no payload',
    ],
    [
      'no metadata',
      envelopeOf({ metadata: undefined as never }),
      'the metadata of the envelope is not a string map',
    ],
    [
      'metadata that is a list',
      envelopeOf({ metadata: [] as never }),
      'the metadata of the envelope is not a string map',
    ],
    [
      'metadata that are not strings',
      envelopeOf({ metadata: { a: 1 } as never }),
      'the metadata of the envelope is not a string map',
    ],
  ])('rejects %s', (_, message, problem) => {
    expect(parseEnvelope(message)).toEqual({ problem })
  })
})
