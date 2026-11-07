---
'dotpress': patch
'@dotpress/auth': patch
---

Packaging: build with tsup, fix `exports` (`types` condition first, valid `types` path, no `require` condition pointing to ESM), publish only `dist/` (compiled tests are no longer shipped), declare `engines.node >= 22`. `dotpress` now declares `zod` as a peer dependency (already required at runtime). No API change.
