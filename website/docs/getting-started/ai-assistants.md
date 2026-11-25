# AI assistants

AI assistants learned Dotpress 1 more than Dotpress 2: without the documentation, they tend to write code for the old API. This site gives them the documentation of Dotpress 2 in Markdown, a format they read better than web pages, following the [llms.txt](https://llmstxt.org) convention.

## The files

| File | Content | Use it to |
| --- | --- | --- |
| [`/llms.txt`](https://dotpress.dev/llms.txt) | An index: the rules an assistant must know, then a link to each page, with a description | give an assistant the whole documentation: it reads the pages it needs |
| [`/llms-full.txt`](https://dotpress.dev/llms-full.txt) | The whole documentation in one file | index the documentation in a tool. It is large: prefer the index for a conversation |
| A `.md` URL for each page | The page in Markdown, such as [`/getting-started/installation.md`](https://dotpress.dev/getting-started/installation.md) | give one page. The menu of each page copies it, or opens it in an assistant |

The files follow the documentation: they are rebuilt with the site, for the current version.

## Give the documentation to an assistant

- **In a conversation**, give the URL of the index along with your request: "Read https://dotpress.dev/llms.txt, then add a route that…". The assistant must be able to read web pages.
- **In your editor**, if it can index a documentation site, add `https://dotpress.dev/llms.txt` or `https://dotpress.dev/llms-full.txt` to its sources.
- **In your project**, write the rule in the instructions file that your assistant reads at the root of the repository (`AGENTS.md`, `CLAUDE.md`, or the file of your tool):

```md title="AGENTS.md"
## Dotpress

This project uses Dotpress 2. Before writing Dotpress code, read
https://dotpress.dev/llms.txt and the pages it links to. Do not use the API of
Dotpress 1 (the `dotpress` package).
```

## What to check in generated code

- **The version.** Imports come from `@dotpress/core` and an adapter, never from `dotpress`. During the beta, `@dotpress/auth` is installed with the `beta` tag: without it, npm installs the plugin of Dotpress 1 (see [Installation](/getting-started/installation)).
- **Errors are returned.** A handler returns `notFoundError()`; it does not throw it (see [Returned errors](/concepts/errors)).
- **No generics.** Types come from the schemas and the path: `defineRoute<…>()` is a sign of an invented API (see [End-to-end typing](/concepts/typing)).
- **The tests.** An app is tested in memory, with `@dotpress/testing` (see [Testing](/routing/testing)): ask the assistant for the tests of what it writes, and run them.
