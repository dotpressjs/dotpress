import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'es2022',
    platform: 'neutral',
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    // Node.js-only command, published as the dotpress-openapi binary.
    entry: { cli: 'src/bin.ts' },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
  },
])
