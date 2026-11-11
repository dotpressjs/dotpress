import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    plugin: 'src/plugin.ts',
    smtp: 'src/providers/smtp.ts',
    'aws-ses': 'src/providers/aws-ses.ts',
    resend: 'src/providers/resend.ts',
    sendgrid: 'src/providers/sendgrid.ts',
    postmark: 'src/providers/postmark.ts',
    brevo: 'src/providers/brevo.ts',
    mailjet: 'src/providers/mailjet.ts',
    mailgun: 'src/providers/mailgun.ts',
    scaleway: 'src/providers/scaleway.ts',
  },
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  // Keep `node:` in the bundles: Deno and Cloudflare Workers need it.
  removeNodeProtocol: false,
  external: [/^node:/],
})
