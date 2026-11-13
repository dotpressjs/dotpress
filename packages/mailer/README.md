# @dotpress/mailer

Typed, multilingual email templates for [Dotpress](https://dotpress.dev), written in [MJML](https://mjml.io) or HTML, with shared layouts, data checked by a Zod schema, and interchangeable providers: SMTP, Amazon SES, Resend, SendGrid, Postmark, Brevo, Mailjet, Mailgun, Scaleway. Works without a Dotpress app: in a script, a worker or a Lambda function.

> 🚧 Dotpress V2 is in alpha (`2.0.0-alpha`): the API may still change before 2.0.0.

```sh
npm install @dotpress/mailer zod
npm install mjml # for MJML templates
```

```ts
import { createMailer, defineTemplate } from '@dotpress/mailer'
import { createSmtpProvider } from '@dotpress/mailer/smtp'
import { z } from 'zod'

export const resetPassword = defineTemplate({
  name: 'resetPassword',
  schema: z.object({ firstName: z.string(), resetUrl: z.url() }),
  subject: { en: 'Reset your password', fr: 'Réinitialisez votre mot de passe' },
  translations: {
    intro: { en: 'Hello {{firstName}}, set a new password:', fr: 'Bonjour {{firstName}}, choisissez un nouveau mot de passe :' },
    cta: { en: 'Reset my password', fr: 'Changer mon mot de passe' },
  },
  mjml: ({ t }) => `
<mjml><mj-body><mj-section><mj-column>
  <mj-text>${t('intro')}</mj-text>
  <mj-button href="{{{resetUrl}}}">${t('cta')}</mj-button>
</mj-column></mj-section></mj-body></mjml>`,
})

const mailer = createMailer({
  provider: createSmtpProvider(process.env.SMTP_URL!),
  from: 'Example <noreply@example.com>',
  defaultLocale: 'en',
})

await mailer.send(resetPassword, {
  to: 'Ada Lovelace <ada@example.com>',
  locale: 'fr-CA', // fr-CA, then fr, then the default locale
  data: { firstName: 'Ada', resetUrl: 'https://app.example.com/reset?token=…' },
})
```

## Documentation

- [Emails](https://dotpress.dev/services/mailer): layouts and templates, rendering and escaping, locales, sending, providers, the plugin, testing
- [Mailer reference](https://dotpress.dev/reference/mailer): every option, the settings and limits of each provider, errors

## License

MIT
