// @ts-check
import { builtinModules } from 'node:module'
import { defineConfig } from 'eslint/config'
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import globals from 'globals'

// Packages that must stay runtime-agnostic: Web-standard APIs only.
const RUNTIME_AGNOSTIC_SOURCES = [
  'packages/core/src/**/*.ts',
  'packages/auth/src/**/*.ts',
  'packages/openapi/src/**/*.ts',
]

const NODE_MESSAGE =
  'Node.js modules are not allowed in runtime-agnostic packages.'
const NODE_MODULES = builtinModules.map((name) => ({
  name,
  message: NODE_MESSAGE,
}))
const NODE_PROTOCOL = { group: ['node:*'], message: NODE_MESSAGE }
const NODE_GLOBALS = [
  'error',
  ...[
    'Buffer',
    'process',
    'global',
    'require',
    'module',
    '__dirname',
    '__filename',
    'setImmediate',
    'clearImmediate',
  ].map((name) => ({
    name,
    message: 'Node.js globals are not allowed in runtime-agnostic packages.',
  })),
]

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'docs/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    // Repository scripts run on Node.js.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: RUNTIME_AGNOSTIC_SOURCES,
    // Node.js-only command of @dotpress/openapi.
    ignores: ['packages/openapi/src/cli.ts', 'packages/openapi/src/bin.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_MODULES,
          patterns: [
            NODE_PROTOCOL,
            {
              group: [
                'express',
                'express/*',
                'hono',
                'hono/*',
                'fastify',
                'fastify/*',
                '@hono/*',
                '@fastify/*',
              ],
              message:
                'Runtime-agnostic packages must not depend on an HTTP server. Use an adapter package.',
            },
          ],
        },
      ],
      'no-restricted-globals': NODE_GLOBALS,
    },
  },
  {
    // Main entry of the Hono adapter: Hono and Web-standard APIs only. The
    // Node.js server lives in its `node` entry.
    files: ['packages/adapter-hono/src/**/*.ts'],
    ignores: ['packages/adapter-hono/src/node.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: NODE_MODULES, patterns: [NODE_PROTOCOL] },
      ],
      'no-restricted-globals': NODE_GLOBALS,
    },
  }
)
