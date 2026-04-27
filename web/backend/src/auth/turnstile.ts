/**
 * Cloudflare Turnstile siteverify. No-op when keys aren't configured so dev
 * setups remain usable without a Cloudflare account.
 */
import { config, isTurnstileConfigured } from '../config.js'

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export async function verifyTurnstile(
  token: string | undefined,
  remoteIp: string | undefined
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isTurnstileConfigured()) return { ok: true }
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing_token' }
  try {
    const body = new URLSearchParams()
    body.set('secret', config.turnstile.secretKey!)
    body.set('response', token)
    if (remoteIp) body.set('remoteip', remoteIp)
    const res = await fetch(VERIFY_URL, { method: 'POST', body })
    if (!res.ok) return { ok: false, reason: 'siteverify_http_' + res.status }
    const json = (await res.json()) as { success?: boolean; 'error-codes'?: string[] }
    if (json.success) return { ok: true }
    return { ok: false, reason: (json['error-codes'] ?? ['unknown']).join(',') }
  } catch (err) {
    return { ok: false, reason: 'siteverify_failed:' + (err as Error).message }
  }
}
