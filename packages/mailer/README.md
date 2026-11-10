# @dotpress/mailer

Typed, multilingual email templates for [Dotpress](https://dotpress.dev), written in [MJML](https://mjml.io) or HTML, with shared layouts. Works without a Dotpress app: in a script, a worker or a Lambda function.

> 🚧 Dotpress V2 is under active development and not published yet.

```sh
pnpm add @dotpress/mailer zod
pnpm add mjml # for MJML templates
```

## Quick start

```ts
import { defineLayout, defineTemplate, renderMail } from '@dotpress/mailer'
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

const { subject, html, text } = await renderMail(resetPassword, {
  locale: 'fr-CA', // fr-CA → fr → defaultLocale
  defaultLocale: 'en',
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

## Rendering

`renderMail(template, { locale, defaultLocale, data })` returns `{ template, locale, subject, html, text }`. It is useful to preview templates, and to test them:

```ts
for (const locale of resetPassword.locales) {
  const mail = await renderMail(resetPassword, { locale, data: sampleData })
  expect(mail.html).toContain('reset?token=')
}
```

## Performance

MJML is loaded on the first render of an MJML template (about 100 to 300 ms), and html-to-text on the first text conversion. MJML compilation is cached by template and locale: later renders only run Mustache, in well under a millisecond.

## Errors

| Error | When |
| --- | --- |
| `TypeError` | invalid `defineTemplate()` or `defineLayout()` options |
| `MailDataError` | data rejected by the schema (`template`, `issues`) |
| `MailRenderError` | MJML missing or invalid, unknown translation key, no available locale, invalid Mustache, failing source function (`template`, `cause`) |

Both error classes extend `MailerError`.

## License

MIT
