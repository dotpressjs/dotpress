---
'@dotpress/cache': patch
---

`cache.getOrSet()`: with an entry typed by its `schema` (or explicit types), the loader may return `undefined` (not found), as the cache already accepted it at runtime: the value is not cached, and the result is typed `T | undefined`. A loader returning a value keeps the result typed `T`.
