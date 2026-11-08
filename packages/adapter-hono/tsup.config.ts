import { defineConfig } from 'tsup'

export default defineConfig({
  // The main entry is runtime-agnostic; `node` is the Node.js server and
  // `lambda` the AWS Lambda handler.
  entry: ['src/index.ts', 'src/node.ts', 'src/lambda.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Keep the `node:` prefix of built-in modules.
  removeNodeProtocol: false,
  dts: true,
  sourcemap: true,
  clean: true,
})
