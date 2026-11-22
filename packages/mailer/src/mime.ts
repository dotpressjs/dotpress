// A MIME message (RFC 5322, 2045 to 2047, 2231, 2387) for the providers
// whose simple API cannot place inline images (Amazon SES). Web APIs only.
import { base64, utf8 } from './encoding.js'
import type { Address, MailAttachment, MailMessage } from './message.js'

const CRLF = '\r\n'
const PRINTABLE = /^[\x20-\x7e]*$/
const TOKEN = /^[!#$%&'*+.^`|~\w-]+$/

/**
 * A header value: as is when printable and short, otherwise in UTF-8
 * encoded-words (RFC 2047) of 39 bytes at most, one per folded line: lines
 * of 78 characters at most.
 */
export const encodeHeaderValue = (value: string) => {
  if (PRINTABLE.test(value) && value.length <= 900) return value
  const words: string[] = []
  let chunk = ''
  let size = 0
  for (const character of value) {
    const bytes = utf8(character).length
    if (size + bytes > 39) {
      words.push(chunk)
      chunk = ''
      size = 0
    }
    chunk += character
    size += bytes
  }
  if (chunk !== '' || words.length === 0) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${base64(word)}?=`).join(`${CRLF} `)
}

/** An address for a header: a non-ASCII name as an encoded-word. */
export const formatMimeAddress = ({ name, address }: Address) => {
  if (name === undefined || name === '') return address
  return PRINTABLE.test(name)
    ? `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`
    : `${encodeHeaderValue(name)} <${address}>`
}

/**
 * A parameter of a header (`filename`, `name`): a token, a quoted string,
 * or a UTF-8 extended value (RFC 2231) for anything else, line breaks
 * included.
 */
const parameter = (name: string, value: string) => {
  if (TOKEN.test(value)) return `${name}=${value}`
  if (PRINTABLE.test(value)) {
    return `${name}="${value.replace(/(["\\])/g, '\\$1')}"`
  }
  const encoded = encodeURIComponent(value).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  )
  return `${name}*=UTF-8''${encoded}`
}

/** One line of text, in quoted-printable lines of 76 characters at most. */
const quotedPrintableLine = (line: string) => {
  const bytes = utf8(line)
  let output = ''
  let current = ''
  bytes.forEach((byte, index) => {
    const last = index === bytes.length - 1
    const literal =
      (byte >= 33 && byte <= 126 && byte !== 61) ||
      ((byte === 32 || byte === 9) && !last)
    const token = literal
      ? String.fromCharCode(byte)
      : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
    // A soft line break ends with "=": 76 characters at most.
    if (current.length + token.length > 75) {
      output += `${current}=${CRLF}`
      current = ''
    }
    current += token
  })
  return output + current
}

/** Text in quoted-printable (RFC 2045), with CRLF line breaks. */
export const quotedPrintable = (text: string) =>
  text
    .split(/\r\n|\r|\n/)
    .map(quotedPrintableLine)
    .join(CRLF)

/** Bytes in base64, in lines of 76 characters. */
const base64Lines = (content: Uint8Array | string) =>
  (base64(content).match(/.{1,76}/g) ?? []).join(CRLF)

const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  ics: 'text/calendar',
}

/**
 * Content type of an attachment: the given one, or from the extension.
 * Text content is sent as UTF-8: a `text/*` type without charset declares
 * it.
 */
export const attachmentType = ({
  filename,
  content,
  contentType,
}: MailAttachment) => {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase()
  const type =
    contentType ??
    (extension === undefined ? undefined : TYPES[extension]) ??
    'application/octet-stream'
  return typeof content === 'string' &&
    /^text\//i.test(type) &&
    !/;\s*charset=/i.test(type)
    ? `${type}; charset=utf-8`
    : type
}

const part = (headers: readonly string[], body: string) =>
  `${headers.join(CRLF)}${CRLF}${CRLF}${body}`

const multipart = (subtype: string, parts: readonly string[]) => {
  const boundary = `=_${crypto.randomUUID()}`
  return part(
    [`Content-Type: multipart/${subtype};${CRLF} boundary="${boundary}"`],
    `${parts.map((item) => `--${boundary}${CRLF}${item}`).join(CRLF)}${CRLF}--${boundary}--`
  )
}

const textPart = (subtype: 'plain' | 'html', text: string) =>
  part(
    [
      `Content-Type: text/${subtype}; charset=UTF-8`,
      'Content-Transfer-Encoding: quoted-printable',
    ],
    quotedPrintable(text)
  )

const attachmentPart = (attachment: MailAttachment) =>
  part(
    [
      `Content-Type: ${attachmentType(attachment)};${CRLF} ${parameter('name', attachment.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${attachment.contentId === undefined ? 'attachment' : 'inline'};${CRLF} ${parameter('filename', attachment.filename)}`,
      ...(attachment.contentId === undefined
        ? []
        : [`Content-ID: <${attachment.contentId}>`]),
    ],
    base64Lines(
      typeof attachment.content === 'string'
        ? utf8(attachment.content)
        : attachment.content
    )
  )

/** Date of a header (RFC 5322), in UTC. */
const mimeDate = (date: Date) => date.toUTCString().replace(/GMT$/, '+0000')

/**
 * The MIME message of a message, without `Bcc` and `Message-ID` (the
 * provider sets them):
 *
 * - `multipart/alternative` of the text and HTML versions;
 * - in a `multipart/related` with the inline attachments, which the HTML
 *   version references with `cid:`;
 * - in a `multipart/mixed` with the other attachments.
 */
export const buildMimeMessage = (
  message: MailMessage,
  date: Date = new Date()
) => {
  const header = (name: string, addresses: readonly Address[]) =>
    addresses.length === 0
      ? []
      : [`${name}: ${addresses.map(formatMimeAddress).join(`,${CRLF} `)}`]

  let body =
    message.html === undefined
      ? textPart('plain', message.text)
      : multipart('alternative', [
          textPart('plain', message.text),
          textPart('html', message.html),
        ])
  const inline = message.attachments.filter(
    ({ contentId }) => contentId !== undefined
  )
  const attached = message.attachments.filter(
    ({ contentId }) => contentId === undefined
  )
  if (inline.length > 0) {
    body = multipart('related', [body, ...inline.map(attachmentPart)])
  }
  if (attached.length > 0) {
    body = multipart('mixed', [body, ...attached.map(attachmentPart)])
  }

  return [
    ...header('From', [message.from]),
    ...header('To', message.to),
    ...header('Cc', message.cc),
    ...header('Reply-To', message.replyTo),
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Date: ${mimeDate(date)}`,
    'MIME-Version: 1.0',
    ...Object.entries(message.headers).map(
      ([name, value]) => `${name}: ${encodeHeaderValue(value)}`
    ),
    body,
  ].join(CRLF)
}
