/**
 * Mod Lookup — frontend client for the backend `/submissions/lookup`
 * endpoint and the helper that maps a `LookupResult` onto our `FormState`.
 *
 * The backend talks to GitHub's REST API or scrapes a BeamNG.com resource
 * page. Whatever it returns is treated as **suggestions**: only blank form
 * fields get filled, so the user never loses edits they've already made.
 */
import { DEFAULT_FORM, MOD_TYPES, parseSourceUrl, type FormState } from './formState'

export interface LookupRelease {
  tag: string
  version: string
  download_url: string | null
  download_size: number | null
  asset_name: string | null
  published_at: string | null
  prerelease: boolean
  notes_markdown: string | null
}

export interface LookupResult {
  source: 'github' | 'beamng'
  source_url: string
  kref: string
  identifier: string
  name?: string
  abstract?: string
  author?: string
  license?: string
  description?: string
  mod_type?: string
  tags: string[]
  thumbnail?: string
  resources: {
    homepage?: string
    repository?: string
    bugtracker?: string
    beamng_resource?: string
  }
  release: LookupRelease | null
  releases: LookupRelease[]
  /** Best-guess BeamMP scope based on file layout, README and topics. */
  multiplayer_scope?: 'client' | 'server' | 'both'
  /** 0–100 confidence that the suggested scope is correct. */
  multiplayer_scope_confidence?: number
  /** Human-readable signals (deduped) that backed the scope decision. */
  multiplayer_scope_reasons?: string[]
  warnings: string[]
  meta: Record<string, unknown>
}

/** Apply a lookup result to the form, filling only empty fields. */
export function applyLookup(
  prev: FormState,
  r: LookupResult,
  opts: { overwrite?: boolean } = {},
): FormState {
  const next: FormState = { ...prev }
  const overwrite = opts.overwrite === true
  const setIfEmpty = <K extends keyof FormState>(key: K, value: FormState[K] | undefined) => {
    if (value === undefined || value === null) return
    const existing = next[key]
    const isEmpty =
      existing === '' ||
      existing === null ||
      existing === undefined ||
      (Array.isArray(existing) && existing.length === 0)
    if (isEmpty || overwrite) next[key] = value
  }

  setIfEmpty('identifier', r.identifier)
  setIfEmpty('name', r.name)
  setIfEmpty('abstract', r.abstract?.slice(0, 512))
  setIfEmpty('author', r.author)
  setIfEmpty('license', r.license)
  setIfEmpty('description', r.description)
  setIfEmpty('thumbnail', r.thumbnail)
  if (r.mod_type && (MOD_TYPES as readonly string[]).includes(r.mod_type)) {
    setIfEmpty('mod_type', r.mod_type)
  }
  if (r.tags.length) setIfEmpty('tags', r.tags)

  // Multiplayer scope is special: the form's default value is 'client', so
  // setIfEmpty wouldn't trigger. Only override when the lookup found
  // confident multiplayer evidence AND the form is still at the default,
  // OR when the user explicitly opted in to overwrite.
  if (r.multiplayer_scope) {
    const stillDefault = next.multiplayer_scope === DEFAULT_FORM.multiplayer_scope
    const confident = (r.multiplayer_scope_confidence ?? 0) >= 25
    if (overwrite || (stillDefault && confident)) {
      next.multiplayer_scope = r.multiplayer_scope
      // Auto-fill never auto-confirms — force the user to acknowledge.
      next.multiplayer_scope_confirmed = false
    }
  }

  // Resources block — set individually, never clobber existing values.
  if (r.resources.homepage) setIfEmpty('homepage', r.resources.homepage)
  if (r.resources.repository) setIfEmpty('repository', r.resources.repository)
  if (r.resources.bugtracker) setIfEmpty('bugtracker', r.resources.bugtracker)
  if (r.resources.beamng_resource) setIfEmpty('beamng_resource', r.resources.beamng_resource)

  // Release-derived fields.
  if (r.release) {
    setIfEmpty('version', r.release.version)
    if (r.release.download_url) setIfEmpty('download', r.release.download_url)
    if (r.release.download_size) setIfEmpty('download_size', r.release.download_size)
    if (r.release.published_at) {
      // Normalize to YYYY-MM-DD if it's an ISO timestamp.
      const date = r.release.published_at.includes('T')
        ? r.release.published_at.split('T')[0]!
        : r.release.published_at
      setIfEmpty('release_date', date)
    }
    if (r.release.prerelease && next.release_status === DEFAULT_FORM.release_status) {
      next.release_status = 'testing'
    }
  }

  // Auto-update wiring: pre-fill the upstream-watch URL from the lookup
  // source so the user only needs to tick the checkbox in the AutoUpdate
  // section to subscribe to future releases.
  setIfEmpty('kref', r.kref)
  if (!next.watch_source_url) {
    // Prefer the canonical source URL we hit — round-trips through
    // parseSourceUrl back to the same kref.
    next.watch_source_url = r.source_url
    void parseSourceUrl // imported for side-effect of re-exporting the
                        // URL convention; actual parse happens in formState
  }

  return next
}
