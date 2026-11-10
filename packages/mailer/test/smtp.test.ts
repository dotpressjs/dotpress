import nodemailer from 'nodemailer'
import { SMTPServer } from 'smtp-server'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createMailer,
  MailSendError,
  type MessageOptions,
} from '../src/index.js'
import {
  createNodemailerProvider,
  createSmtpProvider,
} from '../src/providers/smtp.js'

interface Received {
  from: string | false
  recipients: string[]
  user: unknown
  raw: string
}

const received: Received[] = []
let server: SMTPServer
let port: number

beforeAll(async () => {
  server = new SMTPServer({
    authOptional: true,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _session, callback) {
      if (auth.username === 'user' && auth.password === 'secret') {
        callback(null, { user: auth.username })
      } else {
        callback(new Error('Invalid credentials'))
      }
    },
    onRcptTo(address, _session, callback) {
      if (address.address.endsWith('@rejected.example.com')) {
        callback(
          Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 })
        )
      } else {
        callback()
      }
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom && session.envelope.mailFrom.address,
          recipients: session.envelope.rcptTo.map(({ address }) => address),
          user: session.user,
          raw: Buffer.concat(chunks).toString('utf8'),
        })
        callback()
      })
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const options = () => ({
  host: '127.0.0.1',
  port,
  secure: false,
  ignoreTLS: true,
  auth: { user: 'user', pass: 'secret' },
})

const message: MessageOptions = {
  to: ['Ada Lovelace <ada@example.com>', 'grace@example.com'],
  cc: 'Charles <charles@example.com>',
  bcc: ['archive@example.com'],
  replyTo: 'support@example.com',
  subject: 'Your invoice',
  html: '<p>Hello <b>Ada</b></p>',
  text: 'Hello Ada',
  attachments: [
    {
      filename: 'invoice.pdf',
      // A view on a larger buffer: only bytes 1 to 3 are sent.
      content: new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4),
      contentType: 'application/pdf',
    },
    { filename: 'notes.txt', content: 'Plain notes', contentType: 'text/csv' },
    {
      filename: 'logo.png',
      content: new Uint8Array([9, 9]),
      contentId: 'logo',
    },
  ],
  headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' },
}

/** Unfolded headers and body of a raw message. */
const parse = (raw: string) => raw.replace(/\r\n[ \t]+/g, ' ')

describe('SMTP provider', () => {
  it('sends a complete message to the SMTP server', async () => {
    const provider = createSmtpProvider(options())
    const mailer = createMailer({
      provider,
      from: 'Example <noreply@example.com>',
    })
    const before = received.length
    const result = await mailer.sendMessage(message)

    expect(provider.name).toBe('smtp')
    expect(result.messageId).toMatch(/^<.+@.+>$/)
    expect(received).toHaveLength(before + 1)
    const mail = received.at(-1) as Received
    expect(mail.user).toBe('user')
    expect(mail.from).toBe('noreply@example.com')
    expect(mail.recipients).toEqual([
      'ada@example.com',
      'grace@example.com',
      'charles@example.com',
      'archive@example.com',
    ])

    const raw = parse(mail.raw)
    expect(raw).toContain('From: Example <noreply@example.com>')
    expect(raw).toContain(
      'To: Ada Lovelace <ada@example.com>, grace@example.com'
    )
    expect(raw).toContain('Cc: Charles <charles@example.com>')
    expect(raw).toContain('Reply-To: support@example.com')
    // Blind copies are not visible to recipients.
    expect(raw).not.toMatch(/^Bcc:/im)
    expect(raw).toContain('Subject: Your invoice')
    expect(raw).toContain('List-Unsubscribe: <https://example.com/unsubscribe>')
    expect(raw).toContain(`Message-ID: ${result.messageId}`)
    expect(raw).toMatch(/Content-Type: multipart\/alternative/)
    expect(raw).toContain('Hello Ada')
    expect(raw).toContain('<p>Hello <b>Ada</b></p>')

    expect(raw).toMatch(
      /Content-Type: application\/pdf; name=invoice\.pdf\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=invoice\.pdf\r\n\r\nAQID\r\n/
    )
    expect(raw).toMatch(
      /Content-Type: text\/csv; name=notes\.txt\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=notes\.txt\r\n\r\nUGxhaW4gbm90ZXM=\r\n/
    )
    expect(raw).toMatch(
      /Content-Type: image\/png; name=logo\.png\r\nContent-ID: <logo>\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: inline; filename=logo\.png\r\n\r\nCQk=\r\n/
    )
    provider.close()
  })

  it('encodes non-ASCII names and subjects', async () => {
    const mailer = createMailer({
      provider: createSmtpProvider(options()),
      from: { name: 'Équipe Exemple', address: 'noreply@example.com' },
    })
    await mailer.sendMessage({
      to: 'Zoë <zoe@example.com>',
      subject: 'Réinitialisation du mot de passe',
      text: 'Bonjour',
    })
    const raw = parse((received.at(-1) as Received).raw)
    expect(raw).toMatch(/From: =\?UTF-8\?[QB]\?.+\?= <noreply@example\.com>/)
    expect(raw).toMatch(/To: =\?UTF-8\?[QB]\?.+\?= <zoe@example\.com>/)
    expect(raw).toMatch(/Subject: =\?UTF-8\?[QB]\?/)
    // Text only: no HTML part.
    expect(raw).toMatch(/Content-Type: text\/plain; charset=utf-8/)
    expect(raw).not.toContain('text/html')
  })

  it('accepts a connection URL and pooled connections', async () => {
    for (const config of [
      `smtp://user:secret@127.0.0.1:${port}/?ignoreTLS=true`,
      { ...options(), pool: true as const, maxConnections: 1 },
    ]) {
      const provider = createSmtpProvider(config)
      const mailer = createMailer({ provider, from: 'noreply@example.com' })
      const before = received.length
      await mailer.sendMessage({
        to: 'a@example.com',
        subject: 'Hi',
        text: 'Hi',
      })
      await mailer.sendMessage({
        to: 'b@example.com',
        subject: 'Hi',
        text: 'Hi',
      })
      expect(received).toHaveLength(before + 2)
      provider.close()
    }
  })

  it('reports SMTP errors', async () => {
    const mailer = createMailer({
      provider: createSmtpProvider(options()),
      from: 'noreply@example.com',
    })
    const error = await mailer
      .sendMessage({ to: 'x@rejected.example.com', subject: 'Hi', text: 'Hi' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailSendError)
    expect(error).toMatchObject({ provider: 'smtp', status: undefined })
    expect((error as Error).message).toMatch(
      /^Mail not sent by the smtp provider: .*Mailbox unavailable/
    )
    expect((error as Error).cause).toMatchObject({ responseCode: 550 })

    const badAuth = createMailer({
      provider: createSmtpProvider({
        ...options(),
        auth: { user: 'user', pass: 'wrong' },
      }),
      from: 'noreply@example.com',
    })
    await expect(
      badAuth.sendMessage({ to: 'a@example.com', subject: 'Hi', text: 'Hi' })
    ).rejects.toThrow(/Invalid credentials/)
  })

  it.each([
    ['no options', undefined],
    ['null', null],
    ['a number', 25],
  ])('rejects %s', (_, value) => {
    expect(() => createSmtpProvider(value as never)).toThrow(
      new TypeError(
        'createSmtpProvider(): expected SMTP options or a connection URL.'
      )
    )
  })
})

describe('nodemailer provider', () => {
  it('uses any nodemailer transporter', async () => {
    const transporter = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
    })
    const provider = createNodemailerProvider(transporter)
    expect(provider.name).toBe('nodemailer')
    expect(createNodemailerProvider(transporter, 'sendmail').name).toBe(
      'sendmail'
    )
    const result = await createMailer({
      provider,
      from: 'noreply@example.com',
    }).sendMessage({ to: 'a@example.com', subject: 'Hi', text: 'Hi' })
    expect(result.messageId).toMatch(/^<.+>$/)
  })

  it('ignores message IDs that are not strings', async () => {
    const provider = createNodemailerProvider({
      sendMail: async () => ({ messageId: 42 }),
    })
    expect(provider.close()).toBeUndefined()
    const result = await createMailer({
      provider,
      from: 'noreply@example.com',
    }).sendMessage({ to: 'a@example.com', subject: 'Hi', text: 'Hi' })
    expect(result.messageId).toBeUndefined()
  })

  it('closes the transporter', () => {
    let closed = false
    const provider = createNodemailerProvider({
      sendMail: async () => ({}),
      close: () => {
        closed = true
      },
    })
    provider.close()
    expect(closed).toBe(true)
  })

  it('rejects a value that is not a transporter', () => {
    for (const value of [undefined, {}, { send: () => {} }]) {
      expect(() => createNodemailerProvider(value as never)).toThrow(
        new TypeError(
          'createNodemailerProvider(): expected a nodemailer transporter.'
        )
      )
    }
  })
})
