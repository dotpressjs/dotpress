import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createConsoleProvider,
  createMailer,
  createMemoryProvider,
} from '../src/index.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const message = {
  to: 'Ada <ada@example.com>',
  subject: 'Reset your password',
  html: '<p>Open <a href="https://example.com/reset?token=secret">this link</a></p>',
}

describe('memory provider', () => {
  it('keeps the sent messages', async () => {
    const outbox = createMemoryProvider()
    const mailer = createMailer({ provider: outbox, from: 'a@example.com' })

    expect(outbox.name).toBe('memory')
    expect(outbox.last()).toBeUndefined()
    expect(await mailer.sendMessage({ ...message, subject: 'One' })).toEqual({
      messageId: 'memory-1',
    })
    expect(await mailer.sendMessage({ ...message, subject: 'Two' })).toEqual({
      messageId: 'memory-2',
    })
    expect(outbox.sent.map(({ subject }) => subject)).toEqual(['One', 'Two'])
    expect(outbox.last()?.subject).toBe('Two')

    outbox.clear()
    expect(outbox.sent).toEqual([])
    expect(outbox.last()).toBeUndefined()
    // Identifiers stay unique.
    expect(await mailer.sendMessage(message)).toEqual({ messageId: 'memory-3' })
  })
})

describe('console provider', () => {
  const send = async (
    options: Parameters<typeof createConsoleProvider>[0],
    extra: Record<string, unknown> = {}
  ) => {
    const write = vi.fn()
    const mailer = createMailer({
      provider: createConsoleProvider({ ...options, write }),
      from: 'Example <noreply@example.com>',
    })
    const result = await mailer.sendMessage({ ...message, ...extra })
    expect(result).toEqual({ messageId: undefined })
    expect(write).toHaveBeenCalledOnce()
    return write.mock.calls[0]?.[0] as string
  }

  it('prints the envelope, without the body by default', async () => {
    expect(await send({})).toBe(
      [
        '[mail] message',
        'From: "Example" <noreply@example.com>',
        'To: "Ada" <ada@example.com>',
        'Subject: Reset your password',
      ].join('\n')
    )
  })

  it('prints every recipient, attachments, and the text version', async () => {
    const output = await send(
      { body: true },
      {
        to: ['a@example.com', 'b@example.com'],
        cc: 'c@example.com',
        bcc: 'd@example.com',
        replyTo: 'e@example.com',
        attachments: [
          { filename: 'a.pdf', content: 'A' },
          { filename: 'b.png', content: 'B' },
        ],
      }
    )
    expect(output).toBe(
      [
        '[mail] message',
        'From: "Example" <noreply@example.com>',
        'To: a@example.com, b@example.com',
        'Cc: c@example.com',
        'Bcc: d@example.com',
        'Reply-To: e@example.com',
        'Subject: Reset your password',
        'Attachments: a.pdf, b.png',
        '',
        'Open this link [https://example.com/reset?token=secret]',
      ].join('\n')
    )
  })

  it('prints the template and the locale', async () => {
    const write = vi.fn()
    const provider = createConsoleProvider({ write })
    await provider.send({
      ...(await (async () => {
        const outbox = createMemoryProvider()
        await createMailer({
          provider: outbox,
          from: 'a@example.com',
        }).sendMessage(message)
        return outbox.last()!
      })()),
      template: 'reset',
      locale: 'fr',
    })
    expect(write.mock.calls[0]?.[0]).toMatch(/^\[mail\] reset \(fr\)\n/)
  })

  it('writes to the console by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mailer = createMailer({
      provider: createConsoleProvider(),
      from: 'a@example.com',
    })
    await mailer.sendMessage(message)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[0]).toContain('Subject: Reset your password')
    expect(createConsoleProvider().name).toBe('console')
  })
})
