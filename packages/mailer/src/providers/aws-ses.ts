import {
  SendEmailCommand,
  SESv2Client,
  type SendEmailCommandInput,
  type SendEmailCommandOutput,
  type SESv2ClientConfig,
} from '@aws-sdk/client-sesv2'
import { base64, utf8 } from '../encoding.js'
import { MailSendError } from '../errors.js'
import type { MailProvider } from '../mailer.js'
import { keyValueTags } from './key-value-tags.js'
import {
  checkKeys,
  formatAddress,
  type Address,
  type MailMessage,
} from '../message.js'

/** An SES client, or any object with the same `send()` method. */
export interface SesClient {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>
}

/** Options of `createSesProvider()`. */
export interface SesProviderOptions {
  /** Existing client. Defaults to a client created with `clientConfig`. */
  client?: SesClient | undefined
  /** Configuration of the created client: `region`, `credentials`… */
  clientConfig?: SESv2ClientConfig | undefined
  /** SES configuration set (events, dedicated IPs). */
  configurationSetName?: string | undefined
}

const OPTIONS = new Set(['client', 'clientConfig', 'configurationSetName'])

const UTF8 = 'UTF-8'

/**
 * Address for SES: a display name with non-ASCII characters is encoded
 * (RFC 2047 encoded-word), as SES requires.
 */
const toSesAddress = (address: Address) =>
  address.name !== undefined && /[^\x20-\x7e]/.test(address.name)
    ? `=?UTF-8?B?${base64(address.name)}?= <${address.address}>`
    : formatAddress(address)

/** Tags and metadata as `EmailTags`. */
const emailTags = (message: MailMessage) => {
  const tags = keyValueTags(message, 'SES')
  return tags.length > 0
    ? {
        EmailTags: tags.map(({ name, value }) => ({
          Name: name,
          Value: value,
        })),
      }
    : {}
}

/** `SendEmail` input of a message (simple content). */
const toSendEmailInput = (
  message: MailMessage,
  configurationSetName?: string
): SendEmailCommandInput => ({
  FromEmailAddress: toSesAddress(message.from),
  Destination: {
    ToAddresses: message.to.map(toSesAddress),
    CcAddresses: message.cc.map(toSesAddress),
    BccAddresses: message.bcc.map(toSesAddress),
  },
  ReplyToAddresses: message.replyTo.map(toSesAddress),
  Content: {
    Simple: {
      Subject: { Data: message.subject, Charset: UTF8 },
      Body: {
        Text: { Data: message.text, Charset: UTF8 },
        ...(message.html === undefined
          ? {}
          : { Html: { Data: message.html, Charset: UTF8 } }),
      },
      Headers: Object.entries(message.headers).map(([Name, Value]) => ({
        Name,
        Value,
      })),
      Attachments: message.attachments.map(
        ({ filename, content, contentType, contentId }) => ({
          FileName: filename,
          RawContent: typeof content === 'string' ? utf8(content) : content,
          ...(contentType === undefined ? {} : { ContentType: contentType }),
          ...(contentId === undefined
            ? { ContentDisposition: 'ATTACHMENT' as const }
            : { ContentDisposition: 'INLINE' as const, ContentId: contentId }),
        })
      ),
    },
  },
  ...(configurationSetName === undefined
    ? {}
    : { ConfigurationSetName: configurationSetName }),
  ...emailTags(message),
})

/**
 * Creates a provider that sends messages with Amazon SES (API v2), through
 * the AWS SDK (`@aws-sdk/client-sesv2`, peer dependency). Credentials and
 * region come from the environment unless `clientConfig` sets them.
 *
 * ```ts
 * const provider = createSesProvider({ clientConfig: { region: 'eu-west-3' } })
 * ```
 */
export const createSesProvider = (
  options: SesProviderOptions = {}
): MailProvider => {
  const { client, clientConfig, configurationSetName } = checkKeys(
    'createSesProvider()',
    options,
    OPTIONS
  ) as SesProviderOptions
  if (client !== undefined && clientConfig !== undefined) {
    throw new TypeError(
      'createSesProvider(): set client or clientConfig, not both.'
    )
  }
  if (client !== undefined && typeof client?.send !== 'function') {
    throw new TypeError(
      'createSesProvider(): client must have a send() method.'
    )
  }
  if (
    configurationSetName !== undefined &&
    (typeof configurationSetName !== 'string' || configurationSetName === '')
  ) {
    throw new TypeError(
      'createSesProvider(): configurationSetName must be a non-empty string.'
    )
  }
  const ses = client ?? new SESv2Client(clientConfig ?? {})

  return {
    name: 'aws-ses',
    send: async (message) => {
      // Limits of SES (MailMessageError) are thrown as they are.
      const command = new SendEmailCommand(
        toSendEmailInput(message, configurationSetName)
      )
      let output: SendEmailCommandOutput
      try {
        output = await ses.send(command)
      } catch (error) {
        const status = (
          error as { $metadata?: { httpStatusCode?: unknown } } | null
        )?.$metadata?.httpStatusCode
        // SDK errors: "MessageRejected: Email address is not verified."
        throw new MailSendError('aws-ses', String(error), {
          cause: error,
          status: typeof status === 'number' ? status : undefined,
        })
      }
      return { messageId: output.MessageId }
    },
  }
}
