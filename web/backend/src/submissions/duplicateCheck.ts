/**
 * Duplicate-detection for the submission form. Given a partial set of
 * fields the user has filled in (identifier, download URL, repository,
 * BeamNG resource link, …), find existing registry entries that look like
 * the same mod. The result is surfaced in the UI so authors don't
 * accidentally create a parallel entry when they actually want to edit
 * (or bump the version of) something that's already published.
 *
 * The match is intentionally broad: hitting *any* of identifier / download
 * URL / repository URL / BeamNG resource URL is enough to flag a
 * candidate. False positives are cheap (the user just dismisses the
 * banner) but false negatives lead to duplicate entries we can't easily
 * un-fork later.
 */
import type { ModEntry } from '../registry/index.js'

export type MatchKind =
  | 'identifier_exact'
  | 'download_exact'
  | 'repository_exact'
  | 'beamng_resource_exact'

export interface DuplicateMatch {
  kind: MatchKind
  /** The matched value (normalized for URLs) so the UI can highlight it. */
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

/**
 * Normalize a URL for comparison: lowercase host, strip default ports,
 * trim a trailing slash, drop a trailing `.git`. Returns `null` for
 * things that don't parse — matching anything against `null` is a no-op.
 */
function normalizeUrl(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  const host = u.host.toLowerCase().replace(/^www\./, '')
  let path = u.pathname.replace(/\/+$/, '')
  if (path.endsWith('.git')) path = path.slice(0, -4)
  // Query/fragment are usually irrelevant for "is this the same file?"
  // matching. Drop them so `?download` query strings or anchor IDs don't
  // cause false negatives.
  return `${u.protocol}//${host}${path}`.toLowerCase()
}

function pickResource(entry: ModEntry, key: string): string | undefined {
  if (!entry.resources) return undefined
  const v = entry.resources[key]
  return typeof v === 'string' ? v : undefined
}

function asMatch(entry: ModEntry, kind: MatchKind, matched: string): DuplicateMatch {
  return {
    kind,
    matched,
    identifier: entry.identifier,
    name: entry.name,
    author: entry.author,
    version: entry.version,
    thumbnail: entry.thumbnail,
    download: entry.download,
    multiplayer_scope: entry.multiplayer_scope,
  }
}

/**
 * Find registry entries that look like duplicates of the in-progress
 * submission. Multiple matches can be returned (e.g. same identifier AND
 * same download URL — that's just stronger evidence). At most one entry
 * per identifier is returned, with the strongest match kind preserved.
 */
export function findDuplicates(
  input: DuplicateCheckInput,
  entries: readonly ModEntry[],
  byId: ReadonlyMap<string, ModEntry>,
): DuplicateMatch[] {
  const matches = new Map<string, DuplicateMatch>()
  // Strength order — earlier kinds win when the same entry matches multiple ways.
  const strength: Record<MatchKind, number> = {
    identifier_exact: 4,
    download_exact: 3,
    beamng_resource_exact: 2,
    repository_exact: 1,
  }
  const add = (entry: ModEntry, kind: MatchKind, matched: string) => {
    const existing = matches.get(entry.identifier)
    if (!existing || strength[kind] > strength[existing.kind]) {
      matches.set(entry.identifier, asMatch(entry, kind, matched))
    }
  }

  const wantId = input.identifier?.trim()
  if (wantId) {
    const hit = byId.get(wantId)
    if (hit) add(hit, 'identifier_exact', wantId)
  }

  const wantDownload = normalizeUrl(input.download)
  const wantRepo = normalizeUrl(input.repository)
  const wantResource = normalizeUrl(input.beamng_resource)
  if (!wantDownload && !wantRepo && !wantResource) {
    return Array.from(matches.values())
  }

  for (const entry of entries) {
    if (wantDownload) {
      const got = normalizeUrl(entry.download)
      if (got && got === wantDownload) add(entry, 'download_exact', entry.download!)
    }
    if (wantRepo) {
      const got = normalizeUrl(pickResource(entry, 'repository'))
      if (got && got === wantRepo) add(entry, 'repository_exact', pickResource(entry, 'repository')!)
    }
    if (wantResource) {
      const got = normalizeUrl(pickResource(entry, 'beamng_resource'))
      if (got && got === wantResource) {
        add(entry, 'beamng_resource_exact', pickResource(entry, 'beamng_resource')!)
      }
    }
  }

  return Array.from(matches.values()).sort(
    (a, b) => strength[b.kind] - strength[a.kind],
  )
}
