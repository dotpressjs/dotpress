// Checks the files of the site for AI assistants (website/llms.ts): the
// rules at the top of llms.txt and llms-full.txt, every page in a named
// section, links to existing Markdown pages, and no twoslash marker left.
// Run after `pnpm build`, which builds the site.
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const OUT = new URL('../website/doc_build/', import.meta.url).pathname
const SITE = 'https://dotpress.dev'
const GUIDANCE = 'This documentation covers Dotpress 2.'
const MARKERS = /twoslash|\/\/ ---cut[\w-]*---|^\s*\/\/ @\w+/m

const errors = []

const files = async (directory) =>
  (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? files(path) : [path]
      })
    )
  ).flat()

const read = (name) =>
  readFile(join(OUT, name), 'utf8').catch(() => {
    errors.push(`${name} is missing: build the site first (pnpm build).`)
    return ''
  })

const index = await read('llms.txt')
const full = await read('llms-full.txt')

for (const [name, content] of [
  ['llms.txt', index],
  ['llms-full.txt', full],
]) {
  if (!/^# Dotpress\n\n> /.test(content)) {
    errors.push(`${name} does not start with the title and the summary.`)
  }
  if (!content.slice(0, 2000).includes(GUIDANCE)) {
    errors.push(`${name} does not start with the rules for assistants.`)
  }
}

const sections = [...index.matchAll(/^## (.+)$/gm)].map(([, title]) => title)
if (sections.includes('Others')) {
  errors.push(
    'llms.txt has an "Others" section: a page is outside the nav and the deployment guides. Add it to the nav, or name its section in website/llms.ts.'
  )
}
if (!sections.includes('Optional')) {
  errors.push('llms.txt has no "Optional" section.')
}

const pages = (await files(OUT)).filter((file) => file.endsWith('.md'))
const known = new Set(pages.map((file) => `/${relative(OUT, file)}`))
const links = [...index.matchAll(/^- \[[^\]]+\]\(([^)]+)\)/gm)].map(
  ([, link]) => link
)
for (const link of links) {
  if (!link.startsWith(SITE) || !known.has(link.slice(SITE.length))) {
    errors.push(`llms.txt links to ${link}, which is not a page of the site.`)
  }
}

for (const file of [...pages, join(OUT, 'llms-full.txt')]) {
  const marker = MARKERS.exec(await readFile(file, 'utf8'))
  if (marker !== null) {
    errors.push(`${relative(OUT, file)} contains "${marker[0].trim()}".`)
  }
}

if (errors.length > 0) {
  console.error('The files for AI assistants are not as expected:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
console.log(
  `llms.txt lists ${links.length} pages in ${sections.length} sections; ${pages.length} Markdown pages are clean.`
)
