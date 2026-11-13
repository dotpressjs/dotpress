# AWS Lambda

On AWS Lambda, the API runs in functions that AWS starts on demand: no server to manage, and a cost that follows the traffic. This page covers the infrastructure; for the handler and the bundle, see [the Lambda adapter](/adapters/aws-lambda).

## What to deploy

| Setting | Value |
| --- | --- |
| Code | the bundle of the handler, `dist/lambda.mjs` ([Bundle the handler](/adapters/aws-lambda#bundle-the-handler)) |
| Runtime | Node.js 22 or later |
| Handler | `lambda.handler` |
| Architecture | `arm64` (cheaper) or `x86_64`: the bundle works on both |
| Memory | 512 MB to start: CPU grows with memory, and so does the speed of bcrypt and of cold starts |
| Timeout | above your slowest route, and below the timeout of the trigger |

Deploy it with your tool: AWS SAM, CDK, Serverless Framework, Terraform, SST… Dotpress does not depend on any.

## The trigger

| Trigger | Payload | When |
| --- | --- | --- |
| API Gateway HTTP API | v2 | The default: cheaper and faster than REST APIs |
| Lambda Function URL | v2 | One function, no gateway: the simplest |
| API Gateway REST API | v1 | When you need its features: usage plans, API keys, AWS WAF, request validation |
| Application Load Balancer | ALB | When the API shares a load balancer with other services. Enable the multi-value headers. |

The handler of Dotpress accepts the four: changing the trigger does not change the code.

Mind the limits of the trigger: API Gateway stops a request after about 30 seconds by default (29 for REST APIs), and a synchronous invocation accepts 6 MB of request and response. Keep the [body limit](/routing/bodies#body-size-limit) of upload routes below it, or upload large files directly to S3 with a presigned URL.

## Configuration and secrets

Pass the configuration as environment variables of the function. For secrets (the keys of the tokens, database passwords), use AWS Secrets Manager or Parameter Store, read in the factory of the handler:

```ts
export const handler = createLambdaHandler(async () => {
  const secrets = await loadSecrets() // Secrets Manager, Parameter Store
  const config = loadConfig({ ...process.env, ...secrets })
  return createApp({ adapter: honoAdapter(), routers, plugins: [authPlugin(createAuthService(config))] })
})
```

The factory runs at the first invocation of each execution environment; its result is reused by the next ones. A failure, such as a secret that cannot be read, is retried at the next invocation. The AWS Parameters and Secrets Lambda Extension can cache them locally.

## Cold starts

A cold start creates the execution environment, loads the bundle, and runs the factory. To keep it short:

- **a small bundle**: the Hono adapter gives the smallest one (see [Choosing an adapter](/adapters/));
- **lazy imports** for the code only some routes need: `await import('./pdf.ts')` inside the handler of the route;
- **a short factory**: open connections lazily rather than all at startup;
- **provisioned concurrency**, for latency-sensitive APIs: environments kept ready.

## Databases

Each execution environment keeps its own connections, and Lambda can run hundreds of environments at once. Size the connection pools for many small environments (one connection each is often enough), or put a proxy in front of the database: RDS Proxy, PgBouncer, or a database with an HTTP API.

## Shared state

Every execution environment is a separate instance: the state must be shared, as with several servers. Use a [shared store](/auth/passwords#a-shared-store) for the login throttling, Redis or DynamoDB for the cache, and SQS for the events. See [Several instances](./node#several-instances).

## CORS

Configure CORS either in API Gateway or the Function URL, or in Dotpress, not both: AWS answers preflight requests before the function runs, and the headers would be duplicated. See [CORS](/routing/http-options#cors).

## Logs

The standard output goes to CloudWatch Logs. Log JSON lines (Pino, or the default logger of Dotpress), and filter them with CloudWatch Logs Insights by `requestId`.

## Limits

- **Responses are buffered**: Server-Sent Events are not supported, and `stream()` sends its body once complete. Lambda response streaming is not supported yet.
- **No background work after the response**: an execution environment is frozen once the response is sent. Send the work to a queue with [events](/services/events): the listeners run in another function, triggered by SQS. See [Event workers](./event-workers#amazon-sqs).
