import { defineConfig } from 'tsup'

export default defineConfig({
  // `lambda` is the AWS Lambda handler.
  entry: ['src/index.ts', 'src/lambda.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Keep the `node:` prefix of built-in modules.
  removeNodeProtocol: false,
  dts: true,
  sourcemap: true,
  clean: true,
})
