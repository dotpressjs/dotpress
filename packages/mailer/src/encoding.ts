const encoder = new TextEncoder()

/** UTF-8 bytes of a string. */
export const utf8 = (text: string) => encoder.encode(text)

/** Base64 of bytes, or of the UTF-8 bytes of a string (Web APIs only). */
export const base64 = (content: Uint8Array | string) => {
  const bytes = typeof content === 'string' ? utf8(content) : content
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
