import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/conformance.ts'],
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
