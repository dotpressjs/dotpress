import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      plugin: 'src/plugin.ts',
      'aws-sqs': 'src/transports/aws-sqs.ts',
      bullmq: 'src/transports/bullmq.ts',
      'cloudflare-queues': 'src/transports/cloudflare-queues.ts',
      'pg-boss': 'src/transports/pg-boss.ts',
      'google-pubsub': 'src/transports/google-pubsub.ts',
      'azure-service-bus': 'src/transports/azure-service-bus.ts',
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
  },
  {
    // Node.js-only command, published as the dotpress-events binary.
    entry: { cli: 'src/bin.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
    removeNodeProtocol: false,
  },
])
