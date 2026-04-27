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

// ─── Hostname + extension allowlist ─────────────────────────────────────
// Mods must be served from a known-good origin so we don't end up linking
// the registry to malware drops. GitHub releases + the BeamNG community
// resources site cover the realistic distribution channels for this game.
const ALLOWED_HOST_SUFFIXES = [
  'github.com',
  'githubusercontent.com',
  'beamng.com',
  'beamng.gg',
] as const

// Extensions we will not link to under any circumstances. Anything not
// in this list is allowed (we still encourage .zip via UI, but a future
// archive format shouldn't break the form).
const FORBIDDEN_EXTENSIONS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js',
  '.jar', '.app', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.sh',
])

export interface UrlValidation {
  ok: boolean
  reason?: 'invalid_url' | 'insecure_scheme' | 'forbidden_host' | 'forbidden_extension'
  message?: string
}

export function validateDownloadUrl(rawUrl: string): UrlValidation {
  let u: URL
  try { u = new URL(rawUrl) }
  catch { return { ok: false, reason: 'invalid_url', message: 'Not a valid URL' } }

  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'insecure_scheme', message: 'Download URL must use HTTPS' }
  }

  const host = u.hostname.toLowerCase()
  const hostOk = ALLOWED_HOST_SUFFIXES.some(
    (s) => host === s || host.endsWith('.' + s)
  )
  if (!hostOk) {
    return {
      ok: false,
      reason: 'forbidden_host',
      message: `Downloads must be hosted on GitHub or BeamNG (got ${host})`,
    }
  }

  // Look at the last path segment for an extension.
  const path = u.pathname.toLowerCase()
  const lastDot = path.lastIndexOf('.')
  if (lastDot > path.lastIndexOf('/')) {
    const ext = path.slice(lastDot)
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        reason: 'forbidden_extension',
        message: `File extension ${ext} is not allowed for mod downloads`,
      }
    }
  }

  return { ok: true }
}

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
    // Re-check: a redirect could have landed on a forbidden host.
    if (res.url && res.url !== url) {
      const v = validateDownloadUrl(res.url)
      if (!v.ok) {
        // Surface as a non-ok probe so callers reject it.
        return {
          ok: false,
          status: 0,
          contentLength: null,
          contentType: null,
          finalUrl: res.url,
        }
      }
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
