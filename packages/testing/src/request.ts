/**
 * Creates the request sent by an in-memory target. Form data bodies are
 * serialized first, as HTTP clients do: on Node.js 24, cancelling a body
 * built from a `FormData` (body limit) raises an unhandled rejection in
 * undici.
 */
export const toRequest = async (
  path: string,
  init?: RequestInit
): Promise<Request> => {
  const request = new Request(new URL(path, 'http://localhost'), init)
  if (!(init?.body instanceof FormData)) return request
  return new Request(request, { body: await request.arrayBuffer() })
}
