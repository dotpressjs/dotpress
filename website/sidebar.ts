import type { Sidebar, SidebarGroup } from '@rspress/core'

// The pages of the documentation, in reading order. One sidebar for the
// whole site: each section stays visible from any page.
const groups: SidebarGroup[] = [
  {
    text: 'Getting started',
    items: [
      { text: 'Installation', link: '/getting-started/installation' },
      { text: 'Your first app', link: '/getting-started/first-app' },
      { text: 'Project structure', link: '/getting-started/project-structure' },
    ],
  },
  {
    text: 'Concepts',
    items: [
      { text: 'Request pipeline', link: '/concepts/request-pipeline' },
      { text: 'Returned errors', link: '/concepts/errors' },
      { text: 'Validation and typing', link: '/concepts/validation' },
      { text: 'Request context', link: '/concepts/context' },
      { text: 'Plugins', link: '/concepts/plugins' },
    ],
  },
  {
    text: 'Adapters',
    items: [
      { text: 'Choosing an adapter', link: '/adapters/' },
      { text: 'Express', link: '/adapters/express' },
      { text: 'Fastify', link: '/adapters/fastify' },
      { text: 'Hono', link: '/adapters/hono' },
      { text: 'AWS Lambda', link: '/adapters/aws-lambda' },
    ],
  },
  {
    text: 'Packages',
    items: [
      { text: 'Auth', link: '/packages/auth' },
      { text: 'OpenAPI', link: '/packages/openapi' },
      { text: 'Mailer', link: '/packages/mailer' },
      { text: 'Events', link: '/packages/events' },
      { text: 'Cache', link: '/packages/cache' },
      { text: 'Testing', link: '/packages/testing' },
    ],
  },
  {
    text: 'Deployment',
    items: [
      { text: 'Node.js and containers', link: '/deployment/node' },
      { text: 'AWS Lambda', link: '/deployment/aws-lambda' },
      { text: 'Event workers', link: '/deployment/event-workers' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'Migrate from v1', link: '/migrate-from-v1' },
      {
        text: 'Design decisions',
        link: '/design-decisions/',
        collapsible: true,
        collapsed: true,
        items: [
          {
            text: 'Errors are returned',
            link: '/design-decisions/returned-errors',
          },
          {
            text: 'A declarative registry',
            link: '/design-decisions/declarative-registry',
          },
          {
            text: 'No decorators, no DI',
            link: '/design-decisions/no-decorators',
          },
          {
            text: 'A transport-agnostic core',
            link: '/design-decisions/agnostic-core',
          },
          { text: 'No edge runtime in 2.0', link: '/design-decisions/edge' },
        ],
      },
    ],
  },
  {
    text: 'Examples',
    items: [
      { text: 'Overview', link: '/examples/' },
      { text: 'Express', link: '/examples/express' },
      { text: 'Fastify', link: '/examples/fastify' },
      { text: 'Hono', link: '/examples/hono' },
      { text: 'Auth', link: '/examples/auth' },
      { text: 'Events', link: '/examples/events' },
      { text: 'Mailer', link: '/examples/mailer' },
      { text: 'Cache', link: '/examples/cache' },
      { text: 'Tasks API', link: '/examples/tasks-api' },
    ],
  },
]

export const sidebar: Sidebar = { '/': groups }
