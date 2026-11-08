import { defineConfig } from 'tsup'

export default defineConfig({
  // The main entry is runtime-agnostic; `node` is the Node.js server.
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Keep the `node:` prefix of built-in modules.
  removeNodeProtocol: false,
  dts: true,
  sourcemap: true,
  clean: true,
})
