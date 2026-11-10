import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    plugin: 'src/plugin.ts',
    smtp: 'src/providers/smtp.ts',
    ses: 'src/providers/ses.ts',
    resend: 'src/providers/resend.ts',
    sendgrid: 'src/providers/sendgrid.ts',
  },
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
})
