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
  patch:  <T>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  delete: <T>(p: string) => request<T>('DELETE', p),
  /** Upload a single file via multipart/form-data. Echoes CSRF token. */
  upload: async <T>(
    p: string,
    file: File,
    onProgress?: (loaded: number, total: number) => void,
    query?: Record<string, string>,
  ): Promise<T> => {
    if (!getCookie(CSRF_COOKIE)) {
      await fetch('/api/auth/csrf', { credentials: 'include' })
    }
    const csrf = getCookie(CSRF_COOKIE)
    const form = new FormData()
    form.append('file', file)
    const qs = query ? '?' + new URLSearchParams(query).toString() : ''
    // Use XHR for upload progress; fetch's body progress is still not standardised.
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api${p}${qs}`)
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

  /**
   * Upload a file in sequential chunks of `chunkSize` bytes, each as a raw
   * application/octet-stream POST. Used to bypass the Cloudflare 100 MB per-
   * request body cap. The endpoint must accept query params:
   *   ?upload_id=<token>&chunk_index=<n>&total_chunks=<N>[&...query]
   * and return the final inspect/result payload on the last chunk.
   */
  uploadChunked: async <T>(
    p: string,
    file: File,
    opts?: {
      chunkSize?: number
      onProgress?: (loaded: number, total: number) => void
      query?: Record<string, string>
    },
  ): Promise<T> => {
    const chunkSize = opts?.chunkSize ?? 80 * 1024 * 1024 // 80 MiB (CF cap is 100)
    const onProgress = opts?.onProgress
    if (!getCookie(CSRF_COOKIE)) {
      await fetch('/api/auth/csrf', { credentials: 'include' })
    }
    const csrf = getCookie(CSRF_COOKIE)
    // Random token for the temp file name on the server. Hex-only so it
    // matches the CHUNK_ID_RE regex.
    const uploadId = (
      crypto.randomUUID?.() ?? `${Date.now()}${Math.random().toString(36).slice(2)}`
    ).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
    const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize))
    let lastResult: T | null = null
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize
      const end = Math.min(file.size, start + chunkSize)
      const blob = file.slice(start, end)
      const params = new URLSearchParams({
        upload_id: uploadId,
        chunk_index: String(i),
        total_chunks: String(totalChunks),
        ...(opts?.query ?? {}),
      })
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
      if (csrf) headers[CSRF_HEADER] = csrf
      const res = await fetch(`/api${p}?${params.toString()}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: blob,
      })
      const text = await res.text()
      let parsed: unknown = null
      if (text) {
        try { parsed = JSON.parse(text) } catch { parsed = text }
      }
      if (!res.ok) throw new ApiError(res.status, parsed)
      onProgress?.(end, file.size)
      if (i === totalChunks - 1) lastResult = parsed as T
    }
    return lastResult as T
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
  avatar_url: string | null
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
