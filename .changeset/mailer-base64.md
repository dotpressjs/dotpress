---
'@dotpress/mailer': patch
---

Faster attachments: base64 encoding uses `Uint8Array#toBase64` when the runtime has it, and encodes by chunks otherwise. A 20 MB attachment took about a second of CPU, blocking the event loop.
