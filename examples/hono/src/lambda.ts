// The AWS Lambda entry: API Gateway (REST and HTTP APIs), Function URLs and
// Application Load Balancers. The main entry of the adapter has no Node.js
// server: the bundle stays small.
import { honoAdapter } from '@dotpress/adapter-hono'
import { createLambdaHandler } from '@dotpress/adapter-hono/lambda'
import { createNotesApp, honoOptions } from './app.ts'

// The app is created at the first invocation (cold start), then reused by
// the next invocations of the execution environment.
export const handler = createLambdaHandler(() =>
  createNotesApp(honoAdapter(honoOptions))
)
