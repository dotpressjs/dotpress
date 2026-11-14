---
'@dotpress/events': patch
---

Faster Pub/Sub publishing of large messages: base64 encoding uses `Uint8Array#toBase64` when the runtime has it, and encodes by chunks otherwise. A message of several megabytes took about a second of CPU, blocking the event loop.
