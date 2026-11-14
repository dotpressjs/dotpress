// Internals of the Cloudflare Queues transport, tested on their own.

/**
 * Body of a pulled message: JSON messages may come base64-encoded (RFC
 * 4648), as the documentation says, or as is, as its examples show.
 */
export const decodePulledBody = (body: unknown) => {
  // Plain JSON is not base64 ("{" is not a base64 character): atob()
  // fails, and the body is kept as is.
  if (typeof body !== 'string') return body
  try {
    const bytes = Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return body
  }
}
