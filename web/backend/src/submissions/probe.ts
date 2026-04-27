/**
 * Pre-flight checks for download URLs:
 *   - Reachable (HTTP 200 on HEAD or first byte of GET)
 *   - Optional: stream the body to compute SHA256 + size
 *
 * Bounded by MAX_DOWNLOAD_BYTES to prevent abuse via huge URLs.
 */
import { createHash } from 'node:crypto'

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB
const FETCH_TIMEOUT_MS = 60_000

export interface UrlProbe {
  ok: boolean
  status: number
  contentLength: number | null
  contentType: string | null
  finalUrl: string
}

export async function probeUrl(url: string): Promise<UrlProbe> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal })
    if (res.status === 405 || res.status === 403) {
      // Some hosts disallow HEAD; fall back to a Range GET.
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { Range: 'bytes=0-0' },
      })
      // Drain the tiny body so the connection is released.
      try { await res.body?.cancel() } catch { /* ignore */ }
    }
    const cl = res.headers.get('content-length')
    return {
      ok: res.ok || res.status === 206,
      status: res.status,
      contentLength: cl ? Number(cl) : null,
      contentType: res.headers.get('content-type'),
      finalUrl: res.url,
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface HashResult {
  sha256: string
  size: number
}

export async function downloadAndHash(url: string): Promise<HashResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS * 30) // 30 min for big files
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal })
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: HTTP ${res.status}`)
    }
    const hash = createHash('sha256')
    let size = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        size += value.byteLength
        if (size > MAX_DOWNLOAD_BYTES) throw new Error('Download exceeds 2 GiB cap')
        hash.update(value)
      }
    }
    return { sha256: hash.digest('hex'), size }
  } finally {
    clearTimeout(timer)
  }
}
