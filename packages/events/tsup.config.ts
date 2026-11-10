import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      plugin: 'src/plugin.ts',
      sqs: 'src/transports/sqs.ts',
      bullmq: 'src/transports/bullmq.ts',
      cloudflare: 'src/transports/cloudflare.ts',
    },
    format: ['esm'],
    target: 'es2022',
    platform: 'neutral',
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    // Node.js-only command, published as the dotpress-events binary.
    entry: { cli: 'src/bin.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
  },
])
