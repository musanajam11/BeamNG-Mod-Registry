/**
 * Tiny fetch wrapper that:
 *   - Always sends credentials (cookies).
 *   - Reads the CSRF cookie and mirrors it into X-CSRF-Token on mutating requests.
 *   - Throws on non-2xx with the parsed JSON body so React Query sees errors.
 */
const CSRF_COOKIE = 'rw_csrf'
const CSRF_HEADER = 'X-CSRF-Token'

function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return m && m[1] ? decodeURIComponent(m[1]) : null
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === 'object' && body && 'error' in body ? String((body as { error: string }).error) : `HTTP ${status}`)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Ensure CSRF cookie exists before our first POST.
  if (method !== 'GET' && method !== 'HEAD' && !getCookie(CSRF_COOKIE)) {
    await fetch('/api/auth/csrf', { credentials: 'include' })
  }
  const headers: Record<string, string> = {}
  // Only set Content-Type when we actually have a JSON body — Fastify
  // rejects empty bodies if the header is set.
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const csrf = getCookie(CSRF_COOKIE)
  if (csrf) headers[CSRF_HEADER] = csrf

  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let parsed: unknown = null
  const text = await res.text()
  if (text) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  if (!res.ok) throw new ApiError(res.status, parsed)
  return parsed as T
}

export const api = {
  get:    <T>(p: string) => request<T>('GET', p),
  post:   <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  delete: <T>(p: string) => request<T>('DELETE', p),
  /** Upload a single file via multipart/form-data. Echoes CSRF token. */
  upload: async <T>(p: string, file: File, onProgress?: (loaded: number, total: number) => void): Promise<T> => {
    if (!getCookie(CSRF_COOKIE)) {
      await fetch('/api/auth/csrf', { credentials: 'include' })
    }
    const csrf = getCookie(CSRF_COOKIE)
    const form = new FormData()
    form.append('file', file)
    // Use XHR for upload progress; fetch's body progress is still not standardised.
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api${p}`)
      xhr.withCredentials = true
      if (csrf) xhr.setRequestHeader(CSRF_HEADER, csrf)
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total)
      }
      xhr.onload = () => {
        let parsed: unknown = null
        try { parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { parsed = xhr.responseText }
        if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T)
        else reject(new ApiError(xhr.status, parsed))
      }
      xhr.onerror = () => reject(new ApiError(0, 'network_error'))
      xhr.send(form)
    })
  },
}

export interface User {
  id: number
  email: string
  display_name: string
  role: 'user' | 'admin'
  trust: 'green' | 'yellow' | 'red'
  github_username: string | null
  email_verified: boolean
  created_at: number
}

export interface Submission {
  id: number
  kind: string
  identifier: string
  version: string | null
  status: string
  pr_url: string | null
  error: string | null
  created_at: number
  decided_at: number | null
}
