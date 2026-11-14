const encoder = new TextEncoder()

/** UTF-8 bytes of a string. */
export const utf8 = (text: string) => encoder.encode(text)

/** Bytes turned into characters at once: below the argument limits. */
const CHUNK = 0x8000

/** Uint8Array of the runtimes that encode base64 natively. */
type WithBase64 = Uint8Array & { toBase64?: () => string }

/**
 * Base64 of bytes, or of the UTF-8 bytes of a string (Web APIs only):
 * `Uint8Array#toBase64` when the runtime has it, `btoa` otherwise.
 */
export const base64 = (content: Uint8Array | string) => {
  const bytes: WithBase64 =
    typeof content === 'string' ? utf8(content) : content
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64()
  let binary = ''
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK))
  }
  return btoa(binary)
}
