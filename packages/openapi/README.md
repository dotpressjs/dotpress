# @dotpress/openapi

OpenAPI 3.1 documents generated from the routes of a [Dotpress](https://dotpress.dev) app, with a [Scalar](https://scalar.com) API reference. No annotations: paths, parameters, bodies and responses come from the Zod schemas of the routes, and security from their middlewares.

> 🚧 Dotpress V2 is in beta (`2.0.0-beta`): the API is complete, and changes before 2.0.0 only from feedback.

```sh
npm install @dotpress/openapi
```

```ts
import { createApp } from '@dotpress/core'
import { openapiPlugin } from '@dotpress/openapi'

await createApp({
  adapter,
  plugins: [openapiPlugin({ info: { title: 'My API', version: '1.0.0' } })],
})
// GET /openapi.json: the document
// GET /docs: the Scalar API reference
```

Write the document in CI, without starting the server:

```sh
npx dotpress-openapi src/server.ts --out openapi.json
```

## Documentation

- [OpenAPI](https://dotpress.dev/services/openapi): what is documented, other responses, reusable schemas, security, options, the API reference, the command line

## License

MIT
