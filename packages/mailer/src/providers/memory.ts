import type { MailProvider } from '../mailer.js'
import type { MailMessage } from '../message.js'

/** Provider that keeps messages in memory, for tests. */
export interface MemoryProvider extends MailProvider {
  /** Sent messages, oldest first. */
  readonly sent: readonly MailMessage[]
  /** Last sent message. */
  last(): MailMessage | undefined
  /** Forgets the sent messages. */
  clear(): void
}

/**
 * Creates a provider that keeps messages in memory instead of sending
 * them, for tests.
 *
 * ```ts
 * const outbox = createMemoryProvider()
 * const mailer = createMailer({ provider: outbox, from: 'noreply@example.com' })
 * // …
 * expect(outbox.last()?.subject).toBe('Welcome Ada')
 * ```
 */
export const createMemoryProvider = (): MemoryProvider => {
  const sent: MailMessage[] = []
  let count = 0

  return {
    name: 'memory',
    sent,
    send: async (message) => {
      sent.push(message)
      count += 1
      return { messageId: `memory-${count}` }
    },
    last: () => sent.at(-1),
    clear: () => {
      sent.length = 0
    },
  }
}
