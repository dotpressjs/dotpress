---
'@dotpress/adapter-fastify': patch
'@dotpress/testing': minor
---

**Fastify on AWS Lambda, behind a load balancer without multi-value headers** (the default of a target group): the response sent no cookie at all, as they were only in `multiValueHeaders`, which the load balancer ignores in this mode. It now sends the first cookie in `headers`, like the Hono adapter.

`@dotpress/testing` simulates this load balancer with the `'alb-single-value'` format of `toLambdaEvent()` and `createLambdaTarget()`: one value per header and query key, and the response headers read from `headers` only. `fromLambdaResult()` takes the format as a second argument.
