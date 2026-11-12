import { defineConfig } from '@rspress/core'
import { pluginTwoslash } from '@rspress/plugin-twoslash'
import ts from 'typescript'
import { sidebar } from './sidebar.ts'

const REPOSITORY = 'https://github.com/dotpressjs/dotpress'

export default defineConfig({
  root: 'docs',
  title: 'Dotpress',
  description:
    'A lightweight, decorator-free TypeScript framework for building end-to-end typed backend APIs.',
  lang: 'en',
  // Absolute URLs of the sitemap.
  siteOrigin: 'https://dotpress.dev',
  // Provisional identity: the V1 logo and favicons, until the new logo.
  logo: {
    light: '/logo-light.svg',
    dark: '/logo-dark.svg',
    width: 110,
    height: 25,
  },
  icon: '/favicon.ico',
  head: [
    [
      'link',
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/apple-touch-icon.png',
      },
    ],
    [
      'link',
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/favicon-32x32.png',
      },
    ],
    [
      'link',
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '16x16',
        href: '/favicon-16x16.png',
      },
    ],
  ],
  plugins: [
    // The code blocks marked `twoslash` are compiled against the packages of
    // the workspace: a type error fails the build, and the reader sees the
    // inferred types on hover.
    pluginTwoslash({
      twoslashOptions: {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          strict: true,
          lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
        },
      },
    }),
  ],
  themeConfig: {
    nav: [
      {
        text: 'Guide',
        link: '/getting-started/introduction',
        activeMatch: '^/(getting-started|concepts|routing)/',
      },
      { text: 'Adapters', link: '/adapters/', activeMatch: '^/adapters/' },
      { text: 'Auth', link: '/auth/', activeMatch: '^/auth/' },
      {
        text: 'Services',
        link: '/services/openapi',
        activeMatch: '^/services/',
      },
      {
        text: 'Reference',
        link: '/reference/application',
        activeMatch: '^/reference/',
      },
      { text: 'Examples', link: '/examples/', activeMatch: '^/examples/' },
    ],
    sidebar,
    socialLinks: [{ icon: 'github', mode: 'link', content: REPOSITORY }],
    footer: { message: 'Released under the MIT License.' },
  },
})
