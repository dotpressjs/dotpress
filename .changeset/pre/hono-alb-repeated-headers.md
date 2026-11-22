---
'@dotpress/adapter-hono': patch
---

On AWS Lambda behind a load balancer with multi-value headers, a repeated request header is joined with `, `, as documented and as the other adapters do: `@hono/aws-lambda` joined it with `; `. The `cookie` header keeps `; `.
