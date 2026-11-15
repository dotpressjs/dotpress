# Mailer

The definitions, options, providers and errors of `@dotpress/mailer`. For a guide, see [Emails](/services/mailer).

## defineTemplate()

```ts
defineTemplate({
  name: 'welcome',
  layout: baseLayout,
  schema: z.object({ firstName: z.string() }),
  subject: { en: 'Welcome, {{firstName}}', fr: 'Bienvenue, {{firstName}}' },
  translations: { intro: { en: '…', fr: '…' } },
  mjml: ({ t, locale }) => `<mj-section>…</mj-section>`,
})
```

| Option | Description |
| --- | --- |
| `name` | Used in errors and logs. |
| `layout` | Optional: a layout of the same format (MJML or HTML). |
| `schema` | Optional Zod schema of the data. Without it, the template accepts no data. |
| `subject` | A string, or one per locale. |
| `translations` | Optional: texts by key, each with every locale. Read with `t(key)`. |
| `mjml` | The MJML source: a string, or a function receiving `{ t, locale }`. |
| `html` | Instead of `mjml`: the HTML source. MJML is then never loaded. |
| `text` | Optional text version, a string or a function. Converted from the HTML otherwise. |

Templates are checked when they are defined: unknown options, a missing source, texts without the same locales, or a layout without translations in a locale of the template throw a `TypeError`. `template.locales` lists the locales.

## defineLayout()

```ts
defineLayout({
  translations: { footer: { en: 'Sent by Example.', fr: 'Envoyé par Example.' } },
  mjml: ({ t, content, locale }) => `<mjml lang="${locale}"><mj-body>${content}</mj-body></mjml>`,
})
```

| Option | Description |
| --- | --- |
| `translations` | Optional: texts of the layout. The `t()` of a layout only reads its own translations. |
| `mjml` or `html` | The source, a function receiving `{ t, content, locale }`: `content` is the rendered template. |

In MJML, place `content` inside `<mj-body>`: templates provide `<mj-section>` elements. A layout without translations can be used in any locale. Reusable blocks are plain functions returning MJML. `mj-include` is ignored: templates do not read files.

## Rendering

1. The template function runs with `t()`, then the layout, which receives it as `content`.
2. MJML compiles the result to HTML, cached by template and locale.
3. Mustache inserts the data in the HTML, the subject and the text version.

| Syntax | HTML version | Subject and text version |
| --- | --- | --- |
| `{{value}}` | `& < > " '` escaped | as is |
| `{{{value}}}` | as is | as is |

`/`, `=` and `` ` `` are not escaped, unlike the default of Mustache: many email clients do not decode them in links. Mustache sections work (`{{#items}}…{{/items}}`); partials do not. The subject is a single line: line breaks become spaces.

The text version, without a `text` source, is converted from the HTML by [html-to-text](https://github.com/html-to-text/node-html-to-text): lines wrapped at 78 characters, links followed by their URL, images and hidden elements (such as the MJML preview text) left out.

**Locales**: the rendered locale is the first available among the requested one (`fr-CA`, compared case-insensitively), its base language (`fr`), the `defaultLocale`, then its base language. Otherwise, rendering fails. A template without translations takes the locales of its layout; without translations in both, the locale is ignored.

**Data**: validated by the schema with `safeParseAsync` (async refinements work), and the parsed data is rendered.

`mailer.render(template, { locale, data })` returns `{ template, locale, subject, html, text }`. `renderMail(template, { locale, defaultLocale, data })` does the same without a mailer.

## createMailer()

| Option | Description |
| --- | --- |
| `provider` | Required: the provider that sends. |
| `from` | Required: the default sender. |
| `replyTo` | Optional default reply-to addresses. |
| `defaultLocale` | The locale used when the requested one is not available. |
| `logger` | Optional: logs each sent message. |

### send()

```ts
const { messageId } = await mailer.send(template, options)
```

| Option | Description |
| --- | --- |
| `to` | Required: at least one address. |
| `cc`, `bcc`, `replyTo` | Other recipients; `replyTo` replaces the default. |
| `from` | Replaces the default sender. |
| `subject` | Replaces the subject of the template. |
| `locale` | The requested locale. |
| `data` | The data, typed by the schema. |
| `attachments` | `{ filename, content, contentType?, contentId? }`: `content` is a `Uint8Array` (a Node.js `Buffer` works) or a string; `contentId` makes it inline (`<img src="cid:logo">`). Typed `MailAttachmentInput`; providers receive the validated `MailAttachment`. |
| `headers` | Additional headers. `From`, `To`, `Subject`, `Content-Type` and the other headers set by the mailer are rejected. |
| `tags`, `metadata` | See [Tags and metadata](#tags-and-metadata). |

An address is `'ada@example.com'`, `'Ada Lovelace <ada@example.com>'` or `{ name, address }`, alone or in a list. Recipients, attachments, headers, tags and metadata are checked before rendering: an address without `@` or a line break in a name or a header throws a `MailMessageError`. `messageId` is the identifier given by the provider, if any.

`mailer.sendMessage(options)` sends a message rendered elsewhere: the same options, with `subject`, and `html`, `text` or both. Without `text`, it is converted from `html`.

### Tags and metadata

Tags group messages in the statistics of the provider; metadata comes back in its webhooks, to link a delivery, a bounce or a click to your app.

- **Tags** and **metadata keys**: 1 to 256 letters, digits, `_` or `-`, the strictest rule among providers. Duplicate tags are removed.
- **Metadata values**: strings on one line.

| Provider | `tags` | `metadata` |
| --- | --- | --- |
| SendGrid | `categories` | `custom_args` |
| Postmark | `Tag` (a single tag) | `Metadata` |
| Brevo | `tags` | ignored |
| Mailjet | ignored | `EventPayload` (JSON) |
| Mailgun | `o:tag` | `v:` variables |
| Scaleway | ignored | ignored |
| Amazon SES | `EmailTags`, with the value `true` | `EmailTags` |
| Resend | `tags`, with the value `true` | `tags` |
| SMTP, nodemailer | ignored | ignored |
| console, memory | printed, kept | printed, kept |

A provider without tags or metadata ignores them: switching providers never breaks a call.

## Providers

Every provider sends the sender, the reply-to addresses, several `to`, `cc` and `bcc`, the HTML and text versions, attachments (inline ones included) and additional headers, within the limits of its API. The providers based on an HTTP API (SendGrid, Postmark, Brevo, Mailjet, Mailgun, Scaleway) have no dependency, and accept `baseUrl` (region, proxy, tests) and `fetch` (replaces the global `fetch`); their errors are `MailSendError`, with the HTTP `status` and the message of the API.

| Provider | Import | Settings |
| --- | --- | --- |
| `createMemoryProvider()` | `@dotpress/mailer` | — |
| `createConsoleProvider()` | `@dotpress/mailer` | `body` (prints the text version, off by default: messages contain secrets), `write` |
| `createSmtpProvider()` | `@dotpress/mailer/smtp` | the [nodemailer](https://nodemailer.com/smtp/) options, or a URL (`smtps://user:password@smtp.example.com`); `pool: true` reuses connections, `close()` on shutdown |
| `createNodemailerProvider(transporter, { name? })` | `@dotpress/mailer/smtp` | any nodemailer transporter (sendmail, stream…) |
| `createSesProvider()` | `@dotpress/mailer/aws-ses` | `clientConfig` (region…), or `client`; `configurationSetName` |
| `createResendProvider()` | `@dotpress/mailer/resend` | `apiKey` (else `RESEND_API_KEY`), or `client` |
| `createSendgridProvider()` | `@dotpress/mailer/sendgrid` | `apiKey`; `baseUrl: 'https://api.eu.sendgrid.com'` for EU subusers |
| `createPostmarkProvider()` | `@dotpress/mailer/postmark` | `serverToken` (`POSTMARK_API_TEST` for the test mode), `messageStream` (`outbound` by default) |
| `createBrevoProvider()` | `@dotpress/mailer/brevo` | `apiKey` |
| `createMailjetProvider()` | `@dotpress/mailer/mailjet` | `apiKey`, `apiSecret` |
| `createMailgunProvider()` | `@dotpress/mailer/mailgun` | `apiKey` (or a sending key of the domain), `domain`; `baseUrl: 'https://api.eu.mailgun.net'` in the EU region |
| `createScalewayProvider()` | `@dotpress/mailer/scaleway` | `secretKey`, `projectId`, `region` (`fr-par` by default) |

- **Memory**: `outbox.sent` lists the messages, `last()` returns the last one, `clear()` empties it.
- **SMTP**: nodemailer 10, Node.js only. Install `nodemailer`. SMTP errors (`cause.responseCode`, such as `550`) are `MailSendError`.
- **Amazon SES**: the `SendEmail` operation of the API v2, with `@aws-sdk/client-sesv2` 3.782 or later. Credentials come from the environment. On AWS Lambda, the SDK of the Node.js runtime works, without bundling it, if its version is 3.782 or later.
- **Resend**: install `resend`.
- **SendGrid**: the message ID is read from the `X-Message-Id` response header, when present.
- **Postmark**: the message ID is the `MessageID` of the response; errors include the Postmark `ErrorCode`.
- **Brevo**: the message ID is the `messageId` of the response; errors include the Brevo `code`.
- **Mailjet**: Mailjet returns an identifier per recipient: the message ID is the `MessageUUID` of the first `to` recipient (the numeric `MessageID` without UUID). A message rejected in a successful response is reported as an error too.
- **Mailgun**: reply-to addresses and headers are sent as `h:` options. An inline attachment is sent with its `contentId` as file name, so `cid:` references work as with the other providers. The message ID is the `id` of the response.
- **Scaleway**: the API has no reply-to field: it is sent as a `Reply-To` header. The message ID is the `id` of the email of the first recipient.

### Limits of the providers

Checked before calling the API: a message over a limit throws a `MailMessageError`.

| Provider | Limits |
| --- | --- |
| SendGrid | 10 tags of 255 characters at most; metadata of 10,000 bytes at most (JSON); requests of 30 MB at most |
| Amazon SES, Resend | metadata values of 1 to 256 letters, digits, `_` or `-` (identifiers, not email addresses or dates); a name cannot be both a tag and a metadata key |
| Postmark | 50 recipients (`to`, `cc` and `bcc`); addresses of 254 characters and a sender of 255 at most; subjects of 2,000 characters at most; a single tag; no executable attachments (`.exe`, `.bat`, `.msi`…); requests of 10 MB at most |
| Brevo | a single reply-to address; no inline attachments; names of 70 characters at most; the attachment extensions Brevo accepts (`pdf`, `png`, `docx`, `zip`…) |
| Mailjet | a single reply-to address; requests of 15 MB at most |
| Mailgun | 16 KB at most for the reply-to addresses, additional headers, tags and metadata together |
| Scaleway | no inline attachments; subjects of 998 characters at most; no empty header values |

Request sizes include the attachments, encoded in base64: a third larger than the files.

### Custom providers

A provider has a `name` and a `send(message)` method, which returns `{ messageId }` or nothing. The message is normalized and frozen: `from`, `to`, `cc`, `bcc`, `replyTo` (each `{ name?, address }`), `subject`, `html` (undefined for a text-only message), `text`, `attachments`, `headers`, `tags`, `metadata`, and `template` and `locale` for the logs. `formatAddress()` formats an address for a header (`"Ada" <ada@example.com>`).

Throw a `MailSendError` with the HTTP `status` of the API, and a `MailMessageError` for a message the provider cannot send. Other errors are wrapped in a `MailSendError`.

## mailerPlugin()

```ts
import { mailerPlugin } from '@dotpress/mailer/plugin'

await createApp({ adapter, plugins: [mailerPlugin(mailer)] })
```

The plugin, named `mailer`, provides `ctx.mailer`: the mailer, logging with the request logger (`mailer.withContext({ logger })`). Using `ctx.mailer` without the plugin throws an explicit error. It has its own entry point: the main one does not depend on `@dotpress/core`.

## Logs

With a `logger` (a Dotpress or Pino logger, or any object with `info`, `warn` and `error` methods, and optionally `debug`, taking `(data, message)`), each sent message is logged at the `info` level as `Mail sent`, with the provider, the template, the message ID and the number of recipients. Addresses are not logged. Failures are thrown, not logged.

## Performance

MJML is loaded on the first render of an MJML template (about 100 to 300 ms), and html-to-text on the first text conversion. MJML compilation is cached by template and locale: later renders only run Mustache, in well under a millisecond.

## Errors

| Error | When |
| --- | --- |
| `TypeError` | Invalid options of `defineTemplate()`, `defineLayout()`, `createMailer()`, `send()`… |
| `MailDataError` | The data does not match the schema. Fields: `template`, `issues`. |
| `MailRenderError` | MJML missing or invalid, unknown translation key, no available locale, invalid Mustache, a failing source function. Fields: `template`, `cause`. |
| `MailMessageError` | An invalid address, attachment, header, tag or metadata, or a limit of the provider. |
| `MailSendError` | The provider failed. Fields: `provider`, `status`, `cause`. |

The error classes extend `MailerError`.
