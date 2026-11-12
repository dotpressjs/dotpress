import { defineLayout } from '@dotpress/mailer'

/**
 * The layout of every email of the app; each feature defines its own
 * templates (features/notifications/mails.ts).
 */
export const mailLayout = defineLayout({
  translations: {
    footer: {
      en: 'You receive this email because you are a member of the project.',
      fr: 'Vous recevez cet e-mail car vous êtes membre du projet.',
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
        <mj-text font-size="20px" font-weight="bold">Tasks</mj-text>
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
