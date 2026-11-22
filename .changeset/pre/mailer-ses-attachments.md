---
'@dotpress/mailer': patch
---

The SES provider sends attachments in base64. Without a transfer encoding, SES sent them as 7bit and dropped binary content: images and PDFs arrived empty. A text attachment given as a string with a `text/*` type and no charset now declares `charset=utf-8`.
