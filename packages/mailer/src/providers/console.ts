import type { MailProvider } from '../mailer.js'
import { formatAddress, type Address } from '../message.js'

/** Options of `createConsoleProvider()`. */
export interface ConsoleProviderOptions {
  /**
   * Also prints the text version. Off by default: messages often contain
   * secrets (password reset links, login codes).
   */
  body?: boolean | undefined
  /** Output function. Defaults to `console.log`. */
  write?: ((output: string) => void) | undefined
}

const list = (addresses: readonly Address[]) =>
  addresses.map(formatAddress).join(', ')

/**
 * Creates a provider that prints messages instead of sending them, for
 * development. Never use it as a fallback in production: messages would
 * be lost.
 */
export const createConsoleProvider = (
  options: ConsoleProviderOptions = {}
): MailProvider => {
  const { body = false, write = (output) => console.log(output) } = options

  return {
    name: 'console',
    send: async (message) => {
      const lines = [
        `[mail] ${message.template ?? 'message'}${message.locale ? ` (${message.locale})` : ''}`,
        `From: ${formatAddress(message.from)}`,
        `To: ${list(message.to)}`,
      ]
      for (const [label, addresses] of [
        ['Cc', message.cc],
        ['Bcc', message.bcc],
        ['Reply-To', message.replyTo],
      ] as const) {
        if (addresses.length > 0) lines.push(`${label}: ${list(addresses)}`)
      }
      lines.push(`Subject: ${message.subject}`)
      if (message.attachments.length > 0) {
        lines.push(
          `Attachments: ${message.attachments
            .map(({ filename }) => filename)
            .join(', ')}`
        )
      }
      if (body) lines.push('', message.text)
      write(lines.join('\n'))
    },
  }
}
