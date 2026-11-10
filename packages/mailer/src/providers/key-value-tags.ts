import { MailMessageError } from '../errors.js'
import type { MailMessage } from '../message.js'

// SES and Resend: names and values of 1 to 256 letters, digits, _ or -.
const VALUE = /^[A-Za-z0-9_-]{1,256}$/

/**
 * Tags and metadata as name/value pairs, for providers with a single list
 * (SES, Resend): a tag becomes `{ name: tag, value: 'true' }`.
 */
export const keyValueTags = (message: MailMessage, provider: string) => {
  const pairs = message.tags.map((tag) => ({ name: tag, value: 'true' }))
  for (const [name, value] of Object.entries(message.metadata)) {
    if (!VALUE.test(value)) {
      throw new MailMessageError(
        `${provider} only accepts metadata values of 1 to 256 letters, digits, _ or -: metadata.${name} is ${JSON.stringify(value)}.`
      )
    }
    if (message.tags.includes(name)) {
      throw new MailMessageError(
        `${provider} stores tags and metadata together: "${name}" cannot be both a tag and a metadata key.`
      )
    }
    pairs.push({ name, value })
  }
  return pairs
}
