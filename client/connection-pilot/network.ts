// Defense in depth for the existing shell. No fallback, retries or runtime mocks.
const methods: Readonly<Record<string, readonly string[]>> = {
  '/api/v2/auth/login': ['POST'],
  '/api/v2/auth/logout': ['POST'],
  '/api/v2/auth/logout-all': ['POST'],
  '/api/v2/auth/me': ['GET'],
  '/api/v2/auth/register/request': ['POST'],
  '/api/v2/auth/register/confirm': ['POST'],
  '/api/v2/connections/consent': ['GET'],
  '/api/v2/connections/profile': ['GET'],
  '/api/v2/connections/qr': ['POST'],
  '/api/v2/connections/qr/redeem': ['POST'],
  '/api/v2/connections/revoke': ['POST'],
  '/api/v2/connections/subcontractors': ['GET'],
  '/api/v2/connections/general-contractors': ['GET'],
}
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_REQUEST_BYTES = 8 * 1024
const TIMEOUT_MS = 10_000
const MAX_IN_FLIGHT = 8

export function installConnectionFetch(): void {
  const nativeFetch = window.fetch.bind(window)
  let active = 0
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Only fixed literal relative paths are accepted; URL/Request inputs, queries,
    // redirects and non-allowlisted destinations cannot receive bearer credentials.
    const method = (init?.method || 'GET').toUpperCase()
    if (typeof input !== 'string' || !Object.hasOwn(methods, input) || !methods[input].includes(method) || active >= MAX_IN_FLIGHT) throw new Error('Request unavailable')
    if (init?.body != null && (typeof init.body !== 'string' || new TextEncoder().encode(init.body).length > MAX_REQUEST_BYTES)) throw new Error('Request unavailable')
    const headers = new Headers(init?.headers)
    for (const [name] of headers) if (!['authorization', 'accept', 'content-type'].includes(name)) throw new Error('Request unavailable')
    if (headers.has('authorization') && ['/api/v2/auth/login', '/api/v2/auth/register/request', '/api/v2/auth/register/confirm'].includes(input)) throw new Error('Request unavailable')
    const controller = new AbortController()
    const upstream = init?.signal
    const abort = () => controller.abort()
    if (upstream?.aborted) controller.abort()
    else upstream?.addEventListener('abort', abort, { once: true })
    const timer = window.setTimeout(abort, TIMEOUT_MS)
    active++
    try {
      const response = await nativeFetch(input, { method, headers, body: init?.body, signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', mode: 'same-origin', referrerPolicy: 'no-referrer' })
      if (!response.body || response.status === 204 || response.status === 205 || response.status === 304) {
        if (response.body) await response.body.cancel()
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_RESPONSE_BYTES) { controller.abort(); throw new Error('Request unavailable') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
    } finally {
      active--
      window.clearTimeout(timer)
      upstream?.removeEventListener('abort', abort)
    }
  }
}
