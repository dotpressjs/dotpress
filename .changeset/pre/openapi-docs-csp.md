---
'@dotpress/openapi': minor
---

The API reference page sets its own Content Security Policy: the Scalar script, its inline script by hash, styles, and requests to the document and to its `servers`. It replaces the policy that a security middleware sets for the whole app before the routes, such as `helmet()`, which blocked the page.

`ui.contentSecurityPolicy` adds sources to the directives of the page, or sets no policy with `false`.
