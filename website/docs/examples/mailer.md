# Mailer

A contact form with `@dotpress/mailer`, on Hono. Each message sends two emails, written in [MJML](https://mjml.io):

- a notification to the team, with the visitor as reply-to address: the team answers with the Reply button;
- an acknowledgement to the visitor, in their language (`Accept-Language: fr-CA` gets the French version);
- a shared layout, translated texts, and a text version converted from the HTML one;
- the message of the visitor escaped in the HTML version;
- previews of the templates in the browser, in development;
- SMTP with `SMTP_URL`, and [Mailpit](https://mailpit.axllent.org) to see the delivered emails in development.

Source: [`examples/mailer`](https://github.com/dotpressjs/dotpress/tree/main/examples/mailer).

## Run it

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
docker compose up -d # Mailpit
SMTP_URL=smtp://localhost:1025 npm run dev
```

The emails appear at `http://localhost:8025`, as an email client would show them.

## A template

The schema types the data of the email: a missing field is a type error where the email is sent.

```ts file="<root>/../examples/mailer/src/mails/contact-received.ts"
```

The acknowledgement does not repeat the message: otherwise, anyone could send any text to any address through the form. In production, protect the form against abuse as well (rate limit, CAPTCHA).

## The provider

SMTP with `SMTP_URL`, the console in development only: in production, a missing configuration fails at startup instead of losing the emails.

```ts file="<root>/../examples/mailer/src/mailer.ts"
```

To use the HTTP API of your email service instead of SMTP, replace `createSmtpProvider()` with its provider, for example `createPostmarkProvider()` of `@dotpress/mailer/postmark`: the templates and the routes do not change.

## The routes

```ts file="<root>/../examples/mailer/src/routes.ts"
```

The previews are not served when `NODE_ENV` is `production`.

## Learn more

- [Emails](/services/mailer)
- [Testing helpers](/services/testing#emails)
