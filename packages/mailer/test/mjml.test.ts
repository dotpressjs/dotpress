import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  defineLayout,
  defineTemplate,
  MailRenderError,
  renderMail,
} from '../src/index.js'

const baseLayout = defineLayout({
  translations: {
    tagline: { en: 'Example tagline', fr: "Slogan d'exemple" },
    footer: { en: 'Sent automatically.', fr: 'Envoyé automatiquement.' },
  },
  mjml: ({ t, content }) => `
<mjml>
  <mj-head>
    <mj-preview>{{firstName}}, your link</mj-preview>
    <mj-attributes><mj-text color="#555" /></mj-attributes>
  </mj-head>
  <mj-body background-color="#f6f6f6">
    <mj-section>
      <mj-column>
        <mj-image src="{{{logoUrl}}}" alt="Logo" width="40px" />
        <mj-text>${t('tagline')}</mj-text>
      </mj-column>
    </mj-section>
    ${content}
    <mj-section>
      <mj-column><mj-text font-size="12px">${t('footer')}</mj-text></mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
})

const loginLink = defineTemplate({
  name: 'loginLink',
  layout: baseLayout,
  schema: z.object({
    firstName: z.string(),
    url: z.url(),
    logoUrl: z.url(),
  }),
  subject: {
    en: 'Your login link, {{firstName}}',
    fr: 'Ton lien de connexion, {{firstName}}',
  },
  translations: {
    body: {
      en: 'Click the button below to log in.',
      fr: 'Clique sur le bouton ci-dessous pour te connecter.',
    },
    cta: { en: 'Log in', fr: 'Se connecter' },
  },
  mjml: ({ t }) => `
<mj-section background-color="#fff">
  <mj-column>
    <mj-text>Hello {{firstName}},<br /><br />${t('body')}</mj-text>
    <mj-button href="{{{url}}}">${t('cta')}</mj-button>
    <mj-button href="{{url}}">${t('cta')}</mj-button>
  </mj-column>
</mj-section>`,
})

const data = {
  firstName: "Zoë & O'Neil",
  url: 'https://app.example.com/login?token=a1/b2=&lang=fr',
  logoUrl: 'https://cdn.example.com/logo.png?v=2&s=40',
}

describe('MJML templates', () => {
  it('compiles the template in its layout, then inserts the data', async () => {
    const mail = await renderMail(loginLink, { locale: 'fr-CA', data })

    expect(mail.locale).toBe('fr')
    expect(mail.subject).toBe("Ton lien de connexion, Zoë & O'Neil")
    expect(mail.html).toMatch(/^<!doctype html>/i)
    expect(mail.html).toContain("Slogan d'exemple")
    expect(mail.html).toContain('Hello Zoë &amp; O&#39;Neil,')
    expect(mail.html).toContain(
      'Clique sur le bouton ci-dessous pour te connecter.'
    )
    expect(mail.html).toContain('Envoyé automatiquement.')
    // Placeholders survive MJML in attributes.
    expect(mail.html).toContain(
      'href="https://app.example.com/login?token=a1/b2=&lang=fr"'
    )
    expect(mail.html).toContain(
      'href="https://app.example.com/login?token=a1/b2=&amp;lang=fr"'
    )
    expect(mail.html).toContain(
      'src="https://cdn.example.com/logo.png?v=2&s=40"'
    )
    expect(mail.html).not.toContain('{{')
  })

  it('converts the compiled HTML to text, without preview nor images', async () => {
    const mail = await renderMail(loginLink, { locale: 'en', data })
    expect(mail.text).toBe(
      [
        'Example tagline',
        '',
        "Hello Zoë & O'Neil,",
        '',
        'Click the button below to log in.',
        '',
        'Log in [https://app.example.com/login?token=a1/b2=&lang=fr]',
        '',
        'Log in [https://app.example.com/login?token=a1/b2=&lang=fr]',
        '',
        'Sent automatically.',
      ].join('\n')
    )
  })

  it('reports invalid MJML', async () => {
    const template = defineTemplate({
      name: 'invalid',
      subject: 'Hi',
      mjml: `<mjml><mj-body><mj-unknown />
<mj-section><mj-column><mj-text foo="1">Hi</mj-text></mj-column></mj-section>
</mj-body></mjml>`,
    })
    const error = await renderMail(template, {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailRenderError)
    expect((error as Error).message).toBe(
      'Cannot render mail template "invalid": invalid MJML: line 1 (mj-unknown): Element mj-unknown doesn\'t exist or is not registered; line 2 (mj-text): Attribute foo is illegal'
    )
    expect((error as Error).cause).toBeInstanceOf(Error)
  })

  it('reports MJML parsing failures', async () => {
    const template = defineTemplate({
      name: 'text',
      subject: 'Hi',
      mjml: 'not MJML',
    })
    await expect(renderMail(template, {})).rejects.toThrow(
      'Cannot render mail template "text": invalid MJML: Parsing failed. Check your mjml.'
    )
  })

  it('ignores mj-include', async () => {
    const template = defineTemplate({
      name: 'include',
      subject: 'Hi',
      mjml: '<mjml><mj-body><mj-include path="./test/fixtures/include.mjml" /><mj-section><mj-column><mj-text>Body</mj-text></mj-column></mj-section></mj-body></mjml>',
    })
    const mail = await renderMail(template, {})
    expect(mail.html).toContain('Body')
    expect(mail.html).not.toContain('Included section')
  })
})
