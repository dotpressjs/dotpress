import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    plugin: 'src/plugin.ts',
    als: 'src/als.ts',
    redis: 'src/stores/redis.ts',
    upstash: 'src/stores/upstash.ts',
    'cloudflare-kv': 'src/stores/cloudflare-kv.ts',
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
})
