/**
 * Message sent to a transport: one per listener of an emission. It travels
 * as JSON.
 */
export interface Envelope {
  /** Version of the format. */
  readonly v: 1
  /** Identifier of the message, stable across retries and emissions. */
  readonly id: string
  /** Identifier of the emission, shared by its messages. */
  readonly emissionId: string
  readonly event: string
  readonly listener: string
  /** Payload, as JSON. */
  readonly payload: unknown
  /** ISO date of the emission. */
  readonly emittedAt: string
  readonly metadata: Readonly<Record<string, string>>
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Identifier of the message of a listener for an emission: a UUID (version
 * 8, RFC 9562) derived from both, so that emitting again gives the same
 * identifiers.
 */
export const messageId = async (emissionId: string, listener: string) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${emissionId}\n${listener}`)
  )
  const bytes = new Uint8Array(digest.slice(0, 16))
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const value = hex(bytes)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const STRING_FIELDS = [
  'id',
  'emissionId',
  'event',
  'listener',
  'emittedAt',
] as const

/**
 * Envelope of a received message (an object, or its JSON), or a reason
 * why it is not one.
 */
export const parseEnvelope = (
  message: unknown
): { envelope: Envelope } | { problem: string } => {
  let value = message
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { problem: 'the message is not JSON' }
    }
  }
  if (!isRecord(value)) return { problem: 'the message is not an object' }
  if (value.v !== 1) {
    return {
      problem: `unsupported envelope version ${JSON.stringify(value.v)}`,
    }
  }
  for (const field of STRING_FIELDS) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      return { problem: `the envelope has no ${field}` }
    }
  }
  if (!('payload' in value)) return { problem: 'the envelope has no payload' }
  const { metadata } = value
  if (
    !isRecord(metadata) ||
    !Object.values(metadata).every((item) => typeof item === 'string')
  ) {
    return { problem: 'the metadata of the envelope is not a string map' }
  }
  return { envelope: value as unknown as Envelope }
}
