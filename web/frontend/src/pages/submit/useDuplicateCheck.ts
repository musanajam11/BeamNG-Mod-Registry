/**
 * Debounced duplicate-check hook for the submission form. Watches the
 * fields that uniquely identify a mod (identifier, download URL, source
 * URLs) and asks the backend whether the registry already contains a
 * matching entry. Exposes the matches plus a `dismiss()` function the
 * UI can use to hide the banner without re-running the query.
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../api/client'

export interface DuplicateMatch {
  kind: 'identifier_exact' | 'download_exact' | 'repository_exact' | 'beamng_resource_exact'
  matched: string
  identifier: string
  name: string
  author?: string
  version: string
  thumbnail?: string
  download?: string
  multiplayer_scope?: string
}

export interface DuplicateCheckInput {
  identifier?: string
  download?: string
  repository?: string
  beamng_resource?: string
}

const DEBOUNCE_MS = 400

function normalizedKey(input: DuplicateCheckInput): string {
  return JSON.stringify({
    identifier: (input.identifier ?? '').trim(),
    download: (input.download ?? '').trim(),
    repository: (input.repository ?? '').trim(),
    beamng_resource: (input.beamng_resource ?? '').trim(),
  })
}

export function useDuplicateCheck(input: DuplicateCheckInput, enabled: boolean) {
  const [matches, setMatches] = useState<DuplicateMatch[]>([])
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const key = normalizedKey(input)

  useEffect(() => {
    if (!enabled) return
    const hasAnything =
      Boolean(input.identifier?.trim()) ||
      Boolean(input.download?.trim()) ||
      Boolean(input.repository?.trim()) ||
      Boolean(input.beamng_resource?.trim())
    if (!hasAnything) {
      setMatches([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .post<{ matches: DuplicateMatch[] }>('/submissions/check-duplicate', {
          identifier: input.identifier?.trim() || undefined,
          download: input.download?.trim() || undefined,
          repository: input.repository?.trim() || undefined,
          beamng_resource: input.beamng_resource?.trim() || undefined,
        })
        .then((r) => {
          if (!cancelled) setMatches(r.matches ?? [])
        })
        .catch((err: unknown) => {
          // Silent failure — duplicate-check is an advisory feature; if the
          // backend is unreachable we just don't show the banner. Logging
          // to the console for devs but never surfacing to the user.
          if (err instanceof ApiError) {
            // eslint-disable-next-line no-console
            console.warn('duplicate-check failed', err.body)
          }
          if (!cancelled) setMatches([])
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // We intentionally key off the normalized JSON, not the object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  const visible = dismissedKey === key ? [] : matches

  return {
    matches: visible,
    dismiss: () => setDismissedKey(key),
  }
}
