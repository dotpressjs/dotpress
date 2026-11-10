import { vi } from 'vitest'
import type { MessageOptions } from '../src/index.js'

/** A `fetch` that answers with `response()`, recording the calls. */
export const mockFetch = (response: () => Response) =>
  vi.fn<typeof fetch>(async () => response())

/** JSON response. */
export const json = (status: number, body: unknown, statusText = '') =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  })

/** JSON body of the n-th call of a fetch mock. */
export const bodyOf = (fetchMock: ReturnType<typeof mockFetch>, call = 0) =>
  JSON.parse(fetchMock.mock.calls[call]?.[1]?.body as string) as Record<
    string,
    unknown
  >

/** A message with every field. */
export const fullMessage: MessageOptions = {
  to: ['Ada Lovelace <ada@example.com>', 'grace@example.com'],
  cc: 'Charles <charles@example.com>',
  bcc: ['archive@example.com'],
  replyTo: 'Support <support@example.com>',
  subject: 'Your invoice',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [
    {
      filename: 'invoice.pdf',
      content: new Uint8Array([1, 2, 3]),
      contentType: 'application/pdf',
    },
    { filename: 'notes.txt', content: 'Notes é' },
  ],
  headers: { 'X-Campaign': 'spring' },
  tags: ['invoice'],
  metadata: { invoiceId: 'F-2026-001' },
}

/** A message with the required fields only. */
export const minimalMessage: MessageOptions = {
  to: 'a@example.com',
  subject: 'Hi',
  text: 'Hi',
}

/** A large attachment, for the size limits (base64 grows by 4/3). */
export const largeAttachment = (bytes: number) => ({
  filename: 'large.pdf',
  content: new Uint8Array(bytes),
  contentType: 'application/pdf',
})
