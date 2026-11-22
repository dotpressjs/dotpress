import { describe, expect, it } from 'vitest'
import type { MailMessage } from '../src/message.js'
import {
  attachmentType,
  buildMimeMessage,
  encodeHeaderValue,
  quotedPrintable,
} from '../src/mime.js'

/** Decodes quoted-printable, as a mail client does. */
const decodeQuotedPrintable = (text: string) =>
  Buffer.from(
    text
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      ),
    'latin1'
  ).toString('utf8')

/** Decodes encoded-words, as a mail client does. */
const decodeHeader = (value: string) =>
  value
    .split('\r\n ')
    .map((word) =>
      word.replace(/^=\?UTF-8\?B\?(.*)\?=$/, (_, data: string) =>
        Buffer.from(data, 'base64').toString('latin1')
      )
    )
    .join('')

const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  from: { name: 'Équipe', address: 'noreply@example.com' },
  to: [{ address: 'ada@example.com' }],
  cc: [],
  bcc: [{ address: 'archive@example.com' }],
  replyTo: [],
  subject: 'Hello',
  html: '<p>Hello</p><img src="cid:logo">',
  text: 'Hello',
  attachments: [],
  headers: {},
  tags: [],
  metadata: {},
  template: undefined,
  locale: undefined,
  ...overrides,
})

/** The content types of the parts, in order, from the headers. */
const types = (raw: string) =>
  [...raw.matchAll(/^Content-Type: ([^;\r\n]+)/gm)].map(([, type]) => type)

const lines = (raw: string) => raw.split('\r\n')

describe('quotedPrintable()', () => {
  it('keeps printable ASCII, and encodes the rest', () => {
    expect(quotedPrintable('a = b é')).toBe('a =3D b =C3=A9')
  })

  it('encodes a space or a tab at the end of a line', () => {
    expect(quotedPrintable('a \nb\t')).toBe('a=20\r\nb=09')
  })

  it('wraps lines at 76 characters, without splitting an escape', () => {
    const text = `${'é'.repeat(40)} ${'x'.repeat(100)}`
    const encoded = quotedPrintable(text)
    for (const line of lines(encoded))
      expect(line.length).toBeLessThanOrEqual(76)
    expect(encoded).not.toMatch(/=[0-9A-F]?=\r\n/)
    expect(decodeQuotedPrintable(encoded)).toBe(text)
  })

  it('normalizes line breaks to CRLF', () => {
    expect(quotedPrintable('a\nb\r\nc\rd')).toBe('a\r\nb\r\nc\r\nd')
  })
})

describe('encodeHeaderValue()', () => {
  it('keeps short printable values', () => {
    expect(encodeHeaderValue('<https://example.com/u?a=1&b=2>')).toBe(
      '<https://example.com/u?a=1&b=2>'
    )
  })

  it('encodes other values in folded encoded-words', () => {
    const subject = `Reçu 🎉 ${'très long sujet '.repeat(8)}`
    const encoded = encodeHeaderValue(subject)
    for (const line of lines(`Subject: ${encoded}`)) {
      expect(line.length).toBeLessThanOrEqual(78)
    }
    expect(Buffer.from(decodeHeader(encoded), 'latin1').toString('utf8')).toBe(
      subject
    )
  })
})

describe('attachmentType()', () => {
  it('uses the given type, or the extension', () => {
    expect(
      attachmentType({ filename: 'a.bin', content: '', contentType: 'x/y' })
    ).toBe('x/y')
    expect(
      attachmentType({ filename: 'Logo.PNG', content: new Uint8Array() })
    ).toBe('image/png')
    expect(
      attachmentType({ filename: 'data', content: new Uint8Array() })
    ).toBe('application/octet-stream')
  })

  it('declares UTF-8 for text given as a string', () => {
    expect(attachmentType({ filename: 'a.csv', content: 'é' })).toBe(
      'text/csv; charset=utf-8'
    )
    expect(
      attachmentType({ filename: 'a.csv', content: new Uint8Array() })
    ).toBe('text/csv')
  })
})

describe('buildMimeMessage()', () => {
  const date = new Date('2026-11-22T01:02:03Z')

  it('places inline images with the HTML version, and attachments next to them', () => {
    const raw = buildMimeMessage(
      message({
        attachments: [
          { filename: 'invoice.pdf', content: new Uint8Array([1, 2, 3]) },
          {
            filename: 'logo.png',
            content: new Uint8Array([9]),
            contentId: 'logo',
          },
        ],
      }),
      date
    )
    expect(types(raw)).toEqual([
      'multipart/mixed',
      'multipart/related',
      'multipart/alternative',
      'text/plain',
      'text/html',
      'image/png',
      'application/pdf',
    ])
    expect(raw).toContain(
      'Content-Disposition: inline;\r\n filename=logo.png\r\nContent-ID: <logo>\r\n\r\nCQ=='
    )
    expect(raw).toContain(
      'Content-Disposition: attachment;\r\n filename=invoice.pdf\r\n\r\nAQID'
    )
  })

  it('has no mixed part without other attachments, and no related part without inline ones', () => {
    const inline = {
      filename: 'logo.png',
      content: new Uint8Array([9]),
      contentId: 'logo',
    }
    expect(types(buildMimeMessage(message({ attachments: [inline] })))).toEqual(
      [
        'multipart/related',
        'multipart/alternative',
        'text/plain',
        'text/html',
        'image/png',
      ]
    )
    expect(types(buildMimeMessage(message({ html: undefined })))).toEqual([
      'text/plain',
    ])
  })

  it('writes the headers, without Bcc', () => {
    const raw = buildMimeMessage(
      message({
        to: [
          { name: 'Ada "A" Lovelace', address: 'ada@example.com' },
          { address: 'grace@example.com' },
        ],
        cc: [{ name: 'Zoë', address: 'zoe@example.com' }],
        replyTo: [{ address: 'support@example.com' }],
        subject: 'Reçu',
        headers: { 'List-Unsubscribe': '<https://example.com/u>' },
      }),
      date
    )
    const [head] = raw.split('\r\nContent-Type:')
    expect(head).toBe(
      [
        'From: =?UTF-8?B?w4lxdWlwZQ==?= <noreply@example.com>',
        'To: "Ada \\"A\\" Lovelace" <ada@example.com>,',
        ' grace@example.com',
        'Cc: =?UTF-8?B?Wm/Dqw==?= <zoe@example.com>',
        'Reply-To: support@example.com',
        'Subject: =?UTF-8?B?UmXDp3U=?=',
        'Date: Sun, 22 Nov 2026 01:02:03 +0000',
        'MIME-Version: 1.0',
        'List-Unsubscribe: <https://example.com/u>',
      ].join('\r\n')
    )
    expect(raw).not.toContain('archive@example.com')
  })

  it('encodes file names, so that they cannot add headers', () => {
    const raw = buildMimeMessage(
      message({
        attachments: [
          { filename: 'reçu "x".csv', content: 'a' },
          { filename: 'a "b".txt', content: 'a' },
          { filename: 'evil\r\nX-Injected: yes.txt', content: 'a' },
        ],
      })
    )
    expect(raw).toContain("filename*=UTF-8''re%C3%A7u%20%22x%22.csv")
    expect(raw).toContain('filename="a \\"b\\".txt"')
    expect(raw).toContain("filename*=UTF-8''evil%0D%0AX-Injected%3A%20yes.txt")
    expect(raw).not.toMatch(/^X-Injected/m)
  })

  it('keeps every line within 78 characters, and uses CRLF only', () => {
    const raw = buildMimeMessage(
      message({
        subject: 'é'.repeat(100),
        text: 'x'.repeat(300),
        html: `<p>${'y'.repeat(300)}</p>`,
        attachments: [
          {
            filename: 'logo.png',
            content: new Uint8Array(500),
            contentId: 'logo',
          },
        ],
      })
    )
    for (const line of lines(raw)) expect(line.length).toBeLessThanOrEqual(78)
    expect(raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  })

  it('encodes the text and HTML versions in quoted-printable', () => {
    const raw = buildMimeMessage(message({ text: 'Café', html: '<p>Café</p>' }))
    expect(raw).toContain(
      'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9'
    )
    expect(raw).toContain('<p>Caf=C3=A9</p>')
  })
})
