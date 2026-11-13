import type { Sidebar, SidebarGroup } from '@rspress/core'

// The pages of the site, in reading order: the concepts, then HTTP routing
// on the adapter of your choice, then authentication, then the services.
// The guides share one sidebar; the reference and the examples have their
// own, so that the API details do not get in the way of the guides.

const guides: SidebarGroup[] = [
  {
    text: 'Getting started',
    items: [
      { text: 'Introduction', link: '/getting-started/introduction' },
      { text: 'Installation', link: '/getting-started/installation' },
      { text: 'Quickstart', link: '/getting-started/quickstart' },
      { text: 'Project structure', link: '/getting-started/project-structure' },
    ],
  },
  {
    text: 'Concepts',
    items: [
      { text: 'How Dotpress works', link: '/concepts/how-it-works' },
      { text: 'Request pipeline', link: '/concepts/request-pipeline' },
      { text: 'Request context', link: '/concepts/context' },
      { text: 'End-to-end typing', link: '/concepts/typing' },
      { text: 'Returned errors', link: '/concepts/errors' },
    ],
  },
  {
    text: 'HTTP routing',
    items: [
      { text: 'Routes', link: '/routing/routes' },
      { text: 'Route groups', link: '/routing/groups' },
      { text: 'Validation', link: '/routing/validation' },
      { text: 'Responses', link: '/routing/responses' },
      { text: 'Errors', link: '/routing/errors' },
      { text: 'Middlewares and filters', link: '/routing/middlewares' },
      { text: 'Bodies and file uploads', link: '/routing/bodies' },
      { text: 'CORS, cookies and base path', link: '/routing/http-options' },
      { text: 'Logging and error hooks', link: '/routing/logging' },
      { text: 'Plugins', link: '/routing/plugins' },
      { text: 'Testing', link: '/routing/testing' },
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
    text: 'Authentication',
    items: [
      { text: 'Overview', link: '/auth/' },
      { text: 'Data provider', link: '/auth/data-provider' },
      { text: 'Protecting routes', link: '/auth/protecting-routes' },
      { text: 'Sessions and tokens', link: '/auth/sessions' },
      { text: 'Cookie mode and CSRF', link: '/auth/cookies' },
      { text: 'Clients', link: '/auth/clients' },
      { text: 'Passwords and brute force', link: '/auth/passwords' },
      { text: 'Keys and rotation', link: '/auth/keys' },
      { text: 'Security checklist', link: '/auth/security' },
    ],
  },
  {
    text: 'Services',
    items: [
      { text: 'OpenAPI and API docs', link: '/services/openapi' },
      { text: 'Emails', link: '/services/mailer' },
      { text: 'Events and workers', link: '/services/events' },
      { text: 'Cache and memoization', link: '/services/cache' },
      { text: 'Testing helpers', link: '/services/testing' },
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
]

const reference: SidebarGroup[] = [
  {
    text: 'API reference',
    items: [
      { text: 'Application', link: '/reference/application' },
      { text: 'Routes and groups', link: '/reference/routes' },
      { text: 'Request context', link: '/reference/context' },
      { text: 'Responses and errors', link: '/reference/responses' },
      { text: 'Plugin API', link: '/reference/plugins' },
    ],
  },
  {
    text: 'Packages',
    items: [
      { text: 'Auth', link: '/reference/auth' },
      { text: 'Events', link: '/reference/events' },
    ],
  },
  {
    text: 'Upgrading',
    items: [{ text: 'Migrate from v1', link: '/reference/migrate-from-v1' }],
  },
  {
    text: 'Design decisions',
    items: [
      { text: 'Overview', link: '/reference/design-decisions/' },
      {
        text: 'Errors are returned',
        link: '/reference/design-decisions/returned-errors',
      },
      {
        text: 'A declarative registry',
        link: '/reference/design-decisions/declarative-registry',
      },
      {
        text: 'No decorators, no DI',
        link: '/reference/design-decisions/no-decorators',
      },
      {
        text: 'A transport-agnostic core',
        link: '/reference/design-decisions/agnostic-core',
      },
      {
        text: 'No edge runtime in 2.0',
        link: '/reference/design-decisions/edge',
      },
    ],
  },
]

const examples: SidebarGroup[] = [
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

export const sidebar: Sidebar = {
  '/reference/': reference,
  '/examples/': examples,
  '/': guides,
}
