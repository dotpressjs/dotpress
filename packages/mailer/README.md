# @dotpress/mailer

Typed, multilingual email templates for [Dotpress](https://dotpress.dev), written in [MJML](https://mjml.io) or HTML, with shared layouts, and interchangeable providers to send them. Works without a Dotpress app: in a script, a worker or a Lambda function.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

```sh
pnpm add @dotpress/mailer zod
pnpm add mjml # for MJML templates
pnpm add @dotpress/core # for mailerPlugin
```

## Quick start

```ts
import {
  createConsoleProvider,
  createMailer,
  defineLayout,
  defineTemplate,
} from '@dotpress/mailer'
import { z } from 'zod'

export const baseLayout = defineLayout({
  translations: {
    footer: { en: 'Sent by Acme.', fr: 'Envoyé par Acme.' },
  },
  mjml: ({ t, content, locale }) => `
<mjml lang="${locale}">
  <mj-body background-color="#f6f6f6">
    <mj-section>
      <mj-column><mj-image src="https://cdn.acme.com/logo.png" width="40px" /></mj-column>
    </mj-section>
    ${content}
    <mj-section>
      <mj-column><mj-text font-size="12px">${t('footer')}</mj-text></mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
})

export const resetPassword = defineTemplate({
  name: 'resetPassword',
  layout: baseLayout,
  schema: z.object({ firstName: z.string(), resetUrl: z.url() }),
  subject: {
    en: 'Reset your password, {{firstName}}',
    fr: 'Réinitialisez votre mot de passe, {{firstName}}',
  },
  translations: {
    intro: {
      en: 'Click the button below to set a new password.',
      fr: 'Cliquez sur le bouton ci-dessous pour définir un nouveau mot de passe.',
    },
    cta: { en: 'Reset my password', fr: 'Changer mon mot de passe' },
  },
  mjml: ({ t }) => `
<mj-section background-color="#fff">
  <mj-column>
    <mj-text>Hello {{firstName}},<br /><br />${t('intro')}</mj-text>
    <mj-button href="{{{resetUrl}}}">${t('cta')}</mj-button>
  </mj-column>
</mj-section>`,
})

const mailer = createMailer({
  provider: createConsoleProvider(), // prints messages, for development
  from: 'Acme <noreply@acme.com>',
  defaultLocale: 'en',
})

await mailer.send(resetPassword, {
  to: 'Ada Lovelace <ada@example.com>',
  locale: 'fr-CA', // fr-CA → fr → defaultLocale
  data: { firstName: 'Ada', resetUrl: 'https://app.acme.com/reset?token=…' },
})
```

## How a template is rendered

1. **Translations**: the source function runs with `t()`, which returns the texts of the rendered locale. The layout function then receives the result as `content`, with its own `t()`.
2. **MJML** compiles the result to HTML. This step only depends on the template and the locale, so its result is cached.
3. **Mustache** inserts the data (`{{firstName}}`) in the HTML, the subject and the text versions.

Since translations are inserted before Mustache, they can use the data too: `{ en: 'Hello {{firstName}}' }`. They are inserted as-is: they may contain HTML (`<br />`, `<strong>`).

## Templates

```ts
defineTemplate({
  name: 'welcome', // used in errors and logs
  layout: baseLayout, // optional
  schema: z.object({ … }), // optional: without a schema, the template accepts no data
  subject: 'Welcome', // or { en: 'Welcome', fr: 'Bienvenue' }
  translations: { … }, // optional
  mjml: ({ t, locale }) => `…`, // or html, a string or a function
  text: ({ t, locale }) => `…`, // optional, a string or a function
})
```

Templates are checked when they are defined: unknown options, a missing source, texts that do not have the same locales, or a layout without translations in a locale of the template throw a `TypeError`. TypeScript reports most of these mistakes too.

### HTML templates

Use `html` instead of `mjml` for HTML written by hand or produced by another tool. MJML is then never loaded. A layout and its templates must use the same format.

### Layouts

A layout is a function that receives the template source as `content`. In MJML, place `content` inside `<mj-body>`: templates provide `<mj-section>` elements, so each section can have its own background.

Layouts and templates have separate translations: the `t()` of a layout only reads the layout translations. A layout without translations can be used in any locale.

Reusable blocks are plain functions:

```ts
const button = (href: string, label: string) =>
  `<mj-button href="${href}" background-color="#1992d4">${label}</mj-button>`

mjml: ({ t }) => `<mj-section><mj-column>${button('{{{url}}}', t('cta'))}</mj-column></mj-section>`
```

`mj-include` is ignored: templates do not read files.

### Locales

The locales of a template are those of its `subject` and `translations`; every text needs all of them. A template without translations takes the locales of its layout. A template and layout without translations ignore the locale.

The rendered locale is the first available one among:

1. the requested locale (`fr-CA`), compared case-insensitively;
2. its base language (`fr`);
3. `defaultLocale`, then its base language.

Otherwise, rendering fails. `t()` with an unknown key fails too.

### Data

The data is validated by the schema (`safeParseAsync`, so async refinements work), and the parsed data is rendered. Invalid data throws a `MailDataError` with the list of issues.

### Escaping

| Syntax | HTML version | Subject and text versions |
| --- | --- | --- |
| `{{value}}` | `& < > " '` escaped | inserted as-is |
| `{{{value}}}` | inserted as-is | inserted as-is |

Unlike the default escaping of Mustache, `/`, `=` and `` ` `` are not escaped: many email clients do not decode them in links. Use `{{{url}}}` for URLs built by your app, and `{{value}}` for everything else, in particular user input. Mustache sections work (`{{#items}}…{{/items}}`); partials do not.

### Subject

The subject is rendered by Mustache without HTML escaping, then line breaks are replaced with spaces: a subject is a single line.

### Text version

Without a `text` source, the text version is converted from the HTML version by [html-to-text](https://github.com/html-to-text/node-html-to-text): lines wrapped at 78 characters, links followed by their URL, images and hidden elements (like the MJML preview text) left out.

## Rendering without sending

`mailer.render(template, { locale, data })` returns `{ template, locale, subject, html, text }`, with the default locale of the mailer. `renderMail(template, { locale, defaultLocale, data })` does the same without a mailer. Both are useful to preview templates, and to test them:

```ts
for (const locale of resetPassword.locales) {
  const mail = await renderMail(resetPassword, { locale, data: sampleData })
  expect(mail.html).toContain('reset?token=')
}
```

## Sending

```ts
const mailer = createMailer({
  provider, // see Providers
  from: 'Acme <noreply@acme.com>', // default sender
  replyTo: 'support@acme.com', // optional default
  defaultLocale: 'en',
  logger, // optional: logs each sent message
})
```

### `mailer.send(template, options)`

Renders a template and sends it. Returns `{ messageId }`, the identifier given by the provider (if any).

```ts
await mailer.send(invoiceMail, {
  to: ['ada@example.com', { name: 'Grace Hopper', address: 'grace@example.com' }],
  cc: 'accounting@example.com',
  bcc: ['archive@example.com'],
  replyTo: 'billing@acme.com', // overrides the default
  from: 'Acme Billing <billing@acme.com>', // overrides the default
  subject: 'Your invoice', // overrides the template subject
  locale: user.locale,
  data: { invoiceNumber: 'F-2026-001' },
  attachments: [
    { filename: 'invoice.pdf', content: pdfBytes, contentType: 'application/pdf' },
    { filename: 'logo.png', content: logoBytes, contentId: 'logo' }, // <img src="cid:logo">
  ],
  headers: { 'List-Unsubscribe': '<https://acme.com/unsubscribe?u=42>' },
  tags: ['invoice'], // see Tags and metadata
  metadata: { invoiceId: 'F-2026-001' },
})
```

- **Addresses**: `'ada@example.com'`, `'Ada Lovelace <ada@example.com>'` or `{ name, address }`, alone or in a list. `to` needs at least one address.
- **Attachments**: `content` is a `Uint8Array` (a Node.js `Buffer` works) or a string. `contentId` makes the attachment inline.
- **Headers**: additional headers only. `From`, `To`, `Subject`, `Content-Type` and the other headers set by the mailer are rejected.

Recipients, attachments, headers, tags and metadata are checked before rendering: invalid values (an address without `@`, a line break in a name or a header) throw a `MailMessageError`.

### `mailer.sendMessage(options)`

Sends a message rendered elsewhere: the same options, with `subject`, and `html`, `text` or both. Without `text`, the text version is converted from `html`.

```ts
await mailer.sendMessage({ to, subject: 'Export ready', html: '<p>…</p>' })
```

### Tags and metadata

Most providers can group messages in their statistics (**tags**), and return key/value pairs in their webhooks to link an event (delivery, bounce, click…) to your app (**metadata**).

```ts
await mailer.send(invoiceMail, {
  to,
  data,
  tags: ['invoice', 'billing'],
  metadata: { invoiceId: 'F-2026-001', userId: '42' },
})
```

- **Tags** and **metadata keys** have 1 to 256 letters, digits, `_` or `-`: the strictest rule among providers, so they are valid everywhere. Duplicate tags are removed.
- **Metadata values** are strings on one line.

Each provider translates them to its own API. A provider without tags or metadata ignores them: switching providers never breaks a call, only the grouping is lost.

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
| console | printed | printed |
| memory | kept in the message | kept in the message |

The limits of each provider (number of tags, characters of the values…) are listed in [Limits of the providers](#limits-of-the-providers).

## Providers

| Provider | Import | Use |
| --- | --- | --- |
| `createMemoryProvider()` | `@dotpress/mailer` | tests: keeps messages in `outbox.sent`, checked by `expectMailSent()` of `@dotpress/testing` |
| `createConsoleProvider()` | `@dotpress/mailer` | development: prints the sender, recipients, subject, attachments, tags and metadata |
| `createSmtpProvider()` | `@dotpress/mailer/smtp` | any SMTP server, through nodemailer |
| `createNodemailerProvider()` | `@dotpress/mailer/smtp` | any nodemailer transporter (sendmail, stream…) |
| `createSesProvider()` | `@dotpress/mailer/aws-ses` | Amazon SES (API v2), through the AWS SDK |
| `createResendProvider()` | `@dotpress/mailer/resend` | Resend, through its SDK |
| `createSendgridProvider()` | `@dotpress/mailer/sendgrid` | Twilio SendGrid (Mail Send API v3), through `fetch` |
| `createPostmarkProvider()` | `@dotpress/mailer/postmark` | Postmark (Email API), through `fetch` |
| `createBrevoProvider()` | `@dotpress/mailer/brevo` | Brevo (transactional email API v3), through `fetch` |
| `createMailjetProvider()` | `@dotpress/mailer/mailjet` | Mailjet (Send API v3.1), through `fetch` |
| `createMailgunProvider()` | `@dotpress/mailer/mailgun` | Mailgun (messages API), through `fetch` |
| `createScalewayProvider()` | `@dotpress/mailer/scaleway` | Scaleway Transactional Email, through `fetch` |

Every provider sends the sender and reply-to addresses, multiple `to`, `cc` and `bcc` recipients, the HTML and text versions, attachments (inline ones included) and additional headers, within the limits of its API: a message that the API cannot accept throws a `MailMessageError` before any request (see [Limits of the providers](#limits-of-the-providers)).

The providers based on an HTTP API (SendGrid, Postmark, Brevo, Mailjet, Mailgun, Scaleway) have no dependency, and take two common options: `baseUrl` (region, proxy, tests) and `fetch` (replaces the global `fetch`). Their errors are thrown as `MailSendError`, with the HTTP `status` and the message of the API.

The console provider prints the text version only with `{ body: true }`: messages often contain secrets (reset links, login codes). Never use it as a fallback when the configuration of the real provider is missing: messages would be lost silently.

```ts
const outbox = createMemoryProvider()
const mailer = createMailer({ provider: outbox, from: 'noreply@example.com' })

await signUp('ada@example.com')
expect(outbox.last()).toMatchObject({
  to: [{ address: 'ada@example.com' }],
  template: 'welcome',
})
outbox.clear()
```

### SMTP

```sh
pnpm add nodemailer
```

```ts
import { createSmtpProvider } from '@dotpress/mailer/smtp'

const provider = createSmtpProvider({
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASSWORD! },
  pool: true, // optional: reuses connections
})
// or createSmtpProvider('smtps://user:password@smtp.example.com')

// On shutdown, with pool: true:
provider.close()
```

The options are those of [nodemailer](https://nodemailer.com/smtp/) (nodemailer 10). Most email services also have an SMTP interface: Amazon SES, Postmark, Mailgun, Brevo, Mailjet… SMTP errors (`cause.responseCode`, like `550`) are thrown as `MailSendError`.

`createNodemailerProvider(transporter, name?)` wraps any nodemailer transporter, for instance `nodemailer.createTransport({ sendmail: true })`.

The SMTP provider runs on Node.js only.

### Amazon SES

```sh
pnpm add @aws-sdk/client-sesv2
```

```ts
import { createSesProvider } from '@dotpress/mailer/aws-ses'

const provider = createSesProvider({
  clientConfig: { region: 'eu-west-3' }, // credentials from the environment
  configurationSetName: 'transactional', // optional
})
// or createSesProvider({ client: existingSesV2Client })
```

Messages are sent with the `SendEmail` operation of the SES API v2 (simple content: subject, HTML and text versions, headers and attachments; `@aws-sdk/client-sesv2` 3.782 or later). Display names with non-ASCII characters are encoded as SES requires. SES errors are thrown as `MailSendError`, with the HTTP `status` and the error name (`MessageRejected: Email address is not verified.`).

On AWS Lambda, the Node.js runtimes include the AWS SDK: it does not need to be bundled, as long as the version of the runtime is 3.782 or later.

### Resend

```sh
pnpm add resend
```

```ts
import { createResendProvider } from '@dotpress/mailer/resend'

const provider = createResendProvider({ apiKey: process.env.RESEND_API_KEY })
// or createResendProvider({ client: existingResendClient })
```

Without `apiKey`, the SDK reads the `RESEND_API_KEY` environment variable. Resend errors are thrown as `MailSendError`, with the HTTP `status` and the error name (`validation_error: …`).

### SendGrid

```ts
import { createSendgridProvider } from '@dotpress/mailer/sendgrid'

const provider = createSendgridProvider({
  apiKey: process.env.SENDGRID_API_KEY!,
  // baseUrl: 'https://api.eu.sendgrid.com', // EU regional subusers
})
```

The provider calls the [Mail Send API](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send) (v3) with `fetch`: no SDK to install. The message ID is read from the `X-Message-Id` response header, when present. API errors are thrown as `MailSendError`, with the HTTP `status` and the messages of the response (`400 Invalid from email address`). A `fetch` option replaces the global `fetch` (proxy, tests).

### Postmark

```ts
import { createPostmarkProvider } from '@dotpress/mailer/postmark'

const provider = createPostmarkProvider({
  serverToken: process.env.POSTMARK_SERVER_TOKEN!, // POSTMARK_API_TEST: test mode
  messageStream: 'outbound', // optional, the transactional stream by default
})
```

The provider calls the [Email API](https://postmarkapp.com/developer/api/email-api). The message ID is the `MessageID` of the response. API errors include the Postmark `ErrorCode` (`422 Invalid email request (ErrorCode 300)`).

### Brevo

```ts
import { createBrevoProvider } from '@dotpress/mailer/brevo'

const provider = createBrevoProvider({ apiKey: process.env.BREVO_API_KEY! })
```

The provider calls the [transactional email API](https://developers.brevo.com/reference/sendtransacemail). The message ID is the `messageId` of the response. API errors include the Brevo `code` (`400 invalid_parameter: …`).

### Mailjet

```ts
import { createMailjetProvider } from '@dotpress/mailer/mailjet'

const provider = createMailjetProvider({
  apiKey: process.env.MAILJET_API_KEY!,
  apiSecret: process.env.MAILJET_API_SECRET!,
})
```

The provider calls the [Send API v3.1](https://dev.mailjet.com/email/reference/send-emails/). Mailjet returns an identifier per recipient: the message ID is the `MessageUUID` of the first `to` recipient (the numeric `MessageID` when the UUID is missing). Metadata is sent as `EventPayload` (JSON), returned by the event webhooks. A message rejected in a successful response is reported as an error too.

### Mailgun

```ts
import { createMailgunProvider } from '@dotpress/mailer/mailgun'

const provider = createMailgunProvider({
  apiKey: process.env.MAILGUN_API_KEY!, // or a sending key of the domain
  domain: 'mg.example.com',
  // baseUrl: 'https://api.eu.mailgun.net', // domains of the EU region
})
```

The provider calls the [messages API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages/post-v3--domain-name--messages) with `multipart/form-data` (`FormData`). Reply-to addresses and additional headers are sent as `h:` options, tags as `o:tag` and metadata as `v:` variables. Mailgun references inline images by file name: an inline attachment is sent with its `contentId` as file name, so `<img src="cid:logo">` works as with the other providers. The message ID is the `id` of the response.

### Scaleway

```ts
import { createScalewayProvider } from '@dotpress/mailer/scaleway'

const provider = createScalewayProvider({
  secretKey: process.env.SCW_SECRET_KEY!,
  projectId: process.env.SCW_DEFAULT_PROJECT_ID!,
  region: 'fr-par', // default
})
```

The provider calls the Transactional Email API (`v1alpha1`), with the request format of the official Scaleway SDK. The API has no reply-to field: reply-to addresses are sent as a `Reply-To` additional header. Scaleway returns an email per recipient: the message ID is the `id` of the first one, usable with the API to get the status of the email. Tags and metadata are ignored.

### Limits of the providers

Checked before calling the API; they throw a `MailMessageError`.

| Provider | Limits |
| --- | --- |
| SendGrid | 10 tags of 255 characters at most; metadata of 10,000 bytes at most (JSON); requests of 30 MB at most |
| Amazon SES, Resend | metadata values of 1 to 256 letters, digits, `_` or `-` (use identifiers, not email addresses or dates); a name cannot be both a tag and a metadata key, since both end up in the same list |
| Postmark | 50 recipients (`to`, `cc` and `bcc`); addresses of 254 characters and a sender of 255 characters at most; subjects of 2,000 characters at most; a single tag; no executable attachments (`.exe`, `.bat`, `.msi`…); requests of 10 MB at most |
| Brevo | a single reply-to address; no inline attachments; names of 70 characters at most; attachment extensions accepted by Brevo only (`pdf`, `png`, `docx`, `zip`…) |
| Mailjet | a single reply-to address; requests of 15 MB at most |
| Mailgun | 16 KB at most (16,384 bytes) for the reply-to addresses, additional headers, tags and metadata together |
| Scaleway | no inline attachments; subjects of 998 characters at most; no empty header values |

Request sizes include the attachments, encoded in base64 (a third larger than the files).

### Custom providers

A provider has a `name` and a `send(message)` method, which returns `{ messageId }` or nothing. The message is normalized and frozen: `from`, `to`, `cc`, `bcc`, `replyTo` (`{ name?, address }`), `subject`, `html` (undefined for a text-only message), `text`, `attachments`, `headers`, `tags`, `metadata`, plus `template` and `locale` for logs. `formatAddress()` formats an address for a header (`"Ada" <ada@example.com>`).

Throw a `MailSendError` with the HTTP `status` of the API, if any, and a `MailMessageError` for a message the provider cannot send (a limit of its API). Other errors are wrapped in a `MailSendError`.

## Dotpress plugin

```ts
import { mailerPlugin } from '@dotpress/mailer/plugin'

await createApp({ adapter, plugins: [mailerPlugin(mailer)] })

defineRoute({
  method: 'post',
  path: '/invitations',
  handler: async ({ req, mailer }) => {
    await mailer.send(invitation, { to: req.body.email, data: { team: req.body.team } })
    return { sent: true }
  },
})
```

`ctx.mailer` logs sent messages with the request logger, so logs carry the request ID. Using `ctx.mailer` without the plugin throws an explicit error. The plugin is in its own entry point: the main one does not depend on `@dotpress/core`.

Sending is not retried and not queued: for that, send from a job or a queue consumer.

## Logs

With a `logger` (a Dotpress or Pino logger, or any object with an `info(data, message)` method), each sent message is logged at the `info` level as `Mail sent`, with the provider, the template, the message ID and the number of recipients. Addresses are not logged. Failures are thrown, not logged.

## Performance

MJML is loaded on the first render of an MJML template (about 100 to 300 ms), and html-to-text on the first text conversion. MJML compilation is cached by template and locale: later renders only run Mustache, in well under a millisecond.

## Errors

| Error | When |
| --- | --- |
| `TypeError` | invalid options of `defineTemplate()`, `defineLayout()`, `createMailer()`, `mailer.send()`… |
| `MailDataError` | data rejected by the schema (`template`, `issues`) |
| `MailRenderError` | MJML missing or invalid, unknown translation key, no available locale, invalid Mustache, failing source function (`template`, `cause`) |
| `MailMessageError` | invalid address, attachment, header, tag or metadata, or a limit of the provider |
| `MailSendError` | the provider failed (`provider`, `status`, `cause`) |

The other error classes extend `MailerError`.

## License

MIT
