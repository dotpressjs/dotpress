import { declareContextKey, definePlugin } from '@dotpress/core'
import type { AppServices } from '../services/index.ts'

// ctx.services, typed in every handler and middleware: the IDE completes
// its repositories and their methods. Module augmentation applies to the
// whole program, like the plugins of Dotpress do for ctx.mailer or
// ctx.cache.
declare module '@dotpress/core' {
  interface RequestContext {
    /** The services of the app (src/services): repositories, memos, auth. */
    services: AppServices
  }
}

// Using ctx.services in an app without the plugin throws an explicit error.
declareContextKey('services', 'servicesPlugin')

/**
 * Exposes the services of the app to the routes: the route files are plain
 * modules, without singletons, and the tests give their own services.
 */
export const servicesPlugin = (services: AppServices) =>
  definePlugin({
    name: 'services',
    setup(api) {
      api.decorateContext('services', () => services)
    },
  })
