import { vi } from 'vitest'
import { z } from 'zod'
import {
  defineEvent,
  type Envelope,
  type EventsLogger,
  type Transport,
} from '../src/index.js'

export const practitionerCreated = defineEvent({
  name: 'practitioner.created',
  schema: z.object({ practitionerId: z.string() }),
})

export const recordingUploaded = defineEvent({
  name: 'recording.uploaded',
  schema: z.object({ recordingId: z.string(), size: z.number().int() }),
  transport: 'edge' as never,
})

/** A logger recording its calls. */
export const createLogger = () => {
  const entries: { level: string; data: object; message: string }[] = []
  const log =
    (level: string) =>
    (data: object, message: string): void =>
      void entries.push({ level, data, message })
  const logger: EventsLogger & { entries: typeof entries } = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    entries,
  }
  return logger
}

/** A transport recording the messages it receives. */
export const createRecordingTransport = (kind = 'recording') => {
  const sent: { envelopes: Envelope[]; delay: number | undefined }[] = []
  const send = vi.fn<Transport['send']>(async (envelopes, { delay }) => {
    sent.push({ envelopes: [...envelopes], delay })
  })
  return { kind, send, sent } satisfies Transport & { sent: unknown }
}

/** A valid envelope. */
export const envelopeOf = (overrides: Partial<Envelope> = {}): Envelope => ({
  v: 1,
  id: '00000000-0000-8000-8000-000000000001',
  emissionId: 'emission-1',
  event: 'practitioner.created',
  listener: 'send-welcome-mail',
  payload: { practitionerId: '42' },
  emittedAt: '2026-11-10T10:00:00.000Z',
  metadata: { requestId: 'req-1' },
  ...overrides,
})
