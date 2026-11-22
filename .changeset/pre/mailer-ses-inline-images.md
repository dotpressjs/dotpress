---
'@dotpress/mailer': patch
---

The SES provider sends a message with inline attachments as raw content, built with its images next to the HTML version in a `multipart/related` part. With simple content, SES placed them apart: Thunderbird, among others, showed the image at the end of the message, and its alternative text in the HTML.
