import { defineLayout } from '@dotpress/mailer'

/**
 * Shared by every email: the templates provide the `<mj-section>` elements,
 * placed in `content`. `t()` reads the translations of the layout.
 */
export const baseLayout = defineLayout({
  translations: {
    footer: {
      en: 'Example Inc. · 1 Example Street, Example City',
      fr: 'Example SAS · 1 rue de l’Exemple, Exempleville',
    },
  },
  mjml: ({ t, content, locale }) => `
<mjml lang="${locale}">
  <mj-head>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif" />
      <mj-text font-size="15px" line-height="1.5" color="#1f2933" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f4f5f7">
    <mj-section>
      <mj-column>
        <mj-text font-size="20px" font-weight="bold">Example</mj-text>
      </mj-column>
    </mj-section>
    ${content}
    <mj-section>
      <mj-column>
        <mj-text font-size="12px" color="#6b7280" align="center">${t('footer')}</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
})
