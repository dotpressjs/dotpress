import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Keep the `node:` prefix of built-in modules.
  removeNodeProtocol: false,
  dts: true,
  sourcemap: true,
  clean: true,
})
