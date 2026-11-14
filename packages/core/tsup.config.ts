import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', adapter: 'src/adapter-api.ts' },
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
