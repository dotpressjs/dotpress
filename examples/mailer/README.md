# Dotpress mailer

A contact form with [Dotpress](https://dotpress.dev) and `@dotpress/mailer`, on [Hono](https://hono.dev): each message sends two emails, written in [MJML](https://mjml.io).

- a notification to the team, with the visitor as reply-to address: the team answers with the Reply button;
- an acknowledgement to the visitor, in their language (`Accept-Language`: `fr-CA` gets the French version);
- a shared layout, translated texts, and a text version converted from the HTML one;
- the message of the visitor escaped in the HTML version (`{{message}}`);
- previews of the templates in the browser, in development;
- SMTP with `SMTP_URL`, and [Mailpit](https://mailpit.axllent.org) to see the delivered emails in development.

The acknowledgement does not repeat the message: otherwise, anyone could send any text to any address through the form. In production, protect the form against abuse as well (rate limit, CAPTCHA).

## Run it

Requires Node.js 22.18 or later: Node.js runs the TypeScript sources directly.

```sh
npx degit dotpressjs/dotpress/examples/mailer my-api
cd my-api
npm install
npm run dev
```

```sh
curl -X POST localhost:3000/contact -H 'content-type: application/json' \
  -H 'accept-language: fr' \
  -d '{"name":"Alex","email":"alex@example.com","message":"Hello"}'
```

Without `SMTP_URL`, the emails are printed in the terminal. `http://localhost:3000/previews` shows each template in each language, with sample data.

### With Mailpit

```sh
docker compose up -d # Mailpit, from compose.yaml
SMTP_URL=smtp://localhost:1025 npm run dev
```

The emails sent by the form appear at `http://localhost:8025`, as an email client would show them, with their HTML and text versions and their headers.

`npm test` runs the tests, `npm run typecheck` checks the types. With Mailpit running, `SMTP_URL=smtp://localhost:1025 MAILPIT_URL=http://localhost:8025 npm test` also sends the emails over SMTP and reads them back with the Mailpit API.

## Deploy

| Variable | Content |
| --- | --- |
| `SMTP_URL` | `smtps://user:password@smtp.example.com` (TLS) or `smtp://…:587` (STARTTLS). Required when `NODE_ENV` is `production` |
| `MAIL_FROM` | Sender, from a domain configured in your email service. Defaults to `Example <noreply@example.com>` |
| `CONTACT_TO` | Address of the team. Defaults to `team@example.com` |
| `PORT` | Defaults to `3000` |

Most email services have an SMTP interface (Amazon SES, Postmark, Mailgun, Brevo…). To use their HTTP API instead, replace `createSmtpProvider()` in `src/mailer.ts` with their provider, for example `createPostmarkProvider({ serverToken })` from `@dotpress/mailer/postmark`: the templates and the routes do not change.

The previews are not served when `NODE_ENV` is `production`.

## Files

| File | Content |
| --- | --- |
| `src/mails/layout.ts` | The MJML layout shared by the emails |
| `src/mails/contact-received.ts` | The acknowledgement, in English and French |
| `src/mails/contact-notification.ts` | The notification to the team |
| `src/mails/index.ts` | The templates, and their sample data for the previews |
| `src/mailer.ts` | The provider (SMTP or console) and the mailer |
| `src/locale.ts` | The language of the visitor, from `Accept-Language` |
| `src/routes.ts` | The contact form, and the previews |
| `src/app.ts` | The app, with the mailer plugin |
| `src/server.ts` | The Node.js server (`@hono/node-server`) |
| `compose.yaml` | Mailpit, for development |
| `test/mails.test.ts` | Every template in every language, translations, escaping |
| `test/contact.test.ts` | The contact form, with the memory provider of the mailer |
| `test/locale.test.ts` | The language negotiation |
| `test/server.test.ts` | Tests over HTTP: the form, the previews, the provider |
| `test/mailpit.test.ts` | The emails sent over SMTP to Mailpit (skipped without it) |

The [mailer guide](https://dotpress.dev) covers the other providers (Amazon SES, Resend, SendGrid, Postmark, Brevo, Mailjet, Mailgun, Scaleway), attachments, tags and metadata.
