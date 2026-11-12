import { createLambdaHandler } from '@dotpress/adapter-fastify/lambda'
import { createNotesApp } from './app.ts'

// API Gateway (REST and HTTP APIs), Function URLs and Application Load
// Balancers. The app is created at the first invocation (cold start), then
// reused by the next invocations of the execution environment.
export const handler = createLambdaHandler(() => createNotesApp())
