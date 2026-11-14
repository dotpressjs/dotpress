import { PartialSendError } from '../errors.js'
import { runsInProcess, type Transport } from '../transport.js'
import type { Worker } from '../worker.js'

/**
 * Transport that runs the listeners inside `emit()`, which waits for them
 * and throws an `EventEmitError` when one fails. For development, tests,
 * and apps without a queue. Delays are ignored: listeners run at once.
 */
export const createSyncTransport = (): Transport => {
  let worker: Worker | undefined

  const transport: Transport = {
    kind: 'sync',
    send: async (envelopes) => {
      if (!worker) {
        throw new Error('The sync transport is not used by an event bus.')
      }
      const failed: { id: string; error: unknown }[] = []
      for (const envelope of envelopes) {
        // The bus already serialized the payload as JSON.
        const result = await worker.handle(envelope, { attempt: 1 })
        if (result.status !== 'success') {
          failed.push({ id: envelope.id, error: result.error })
        }
      }
      if (failed.length > 0) throw new PartialSendError(failed)
    },
  }
  return runsInProcess(transport, {
    maxAttempts: 1,
    bind: (bound) => {
      worker = bound
    },
  })
}
