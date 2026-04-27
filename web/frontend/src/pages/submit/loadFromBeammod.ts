/**
 * Map a raw `.beammod` JSON object back into our editable FormState. This
 * is the inverse of `buildPayload` and is used by the "Propose edit" path
 * from the Registry Browser so authors can tweak an existing entry
 * without retyping every field.
 *
 * Anything we don't recognise gets stashed into `kref`/`comment` only if
 * those fields are already strings; otherwise we silently drop unknowns
 * (the form's Advanced section can still set them).
 */
import {
  DEFAULT_FORM, KINDS, MULTIPLAYER_SCOPES, RELEASE_STATUSES,
  type FormState, type InstallDirective, type Relationship,
} from './formState'

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

function asRelationships(v: unknown): Relationship[] {
  if (!Array.isArray(v)) return []
  const out: Relationship[] = []
  for (const item of v) {
    if (typeof item === 'string') {
      out.push({ identifier: item })
    } else if (item && typeof item === 'object') {
      const r = item as Record<string, unknown>
      const id = asString(r.identifier)
      if (!id) continue
      out.push({
        identifier: id,
        min_version: asString(r.min_version),
        max_version: asString(r.max_version),
      })
    }
  }
  return out
}

function asInstall(v: unknown): InstallDirective[] {
  if (!Array.isArray(v)) return []
  const out: InstallDirective[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const installTo = asString(r.install_to) ?? ''
    if (!installTo) continue
    let matchType: InstallDirective['match_type']
    let matchValue: string
    if (asString(r.file)) { matchType = 'file'; matchValue = asString(r.file)! }
    else if (asString(r.find)) { matchType = 'find'; matchValue = asString(r.find)! }
    else if (asString(r.find_regexp)) { matchType = 'find_regexp'; matchValue = asString(r.find_regexp)! }
    else continue
    out.push({
      match_type: matchType,
      match_value: matchValue,
      install_to: installTo,
      as: asString(r.as),
      filter: asString(r.filter),
      filter_regexp: asString(r.filter_regexp),
      include_only: asString(r.include_only),
      include_only_regexp: asString(r.include_only_regexp),
      find_matches_files: r.find_matches_files === true,
    })
  }
  return out
}

export function loadFromBeammod(raw: Record<string, unknown>): FormState {
  const f: FormState = { ...DEFAULT_FORM }
  const s = (k: string) => asString(raw[k])

  f.identifier = s('identifier') ?? ''
  f.name = s('name') ?? ''
  f.abstract = s('abstract') ?? ''
  f.author = s('author') ?? ''
  f.version = s('version') ?? ''
  f.license = s('license') ?? ''

  const kind = s('kind')
  if (kind && (KINDS as readonly string[]).includes(kind)) {
    f.kind = kind as FormState['kind']
  }
  f.mod_type = s('mod_type') ?? null

  const dl = raw.download
  if (typeof dl === 'string') f.download = dl
  else if (Array.isArray(dl) && typeof dl[0] === 'string') f.download = dl[0]

  f.download_size = asNumber(raw.download_size)
  f.install_size = asNumber(raw.install_size)
  f.thumbnail = s('thumbnail') ?? ''
  f.tags = asStringArray(raw.tags)
  f.description = s('description') ?? ''

  const rs = s('release_status')
  if (rs && (RELEASE_STATUSES as readonly string[]).includes(rs)) {
    f.release_status = rs as FormState['release_status']
  }
  f.release_date = s('release_date') ?? ''
  f.beamng_version = s('beamng_version') ?? ''
  f.beamng_version_min = s('beamng_version_min') ?? ''
  f.beamng_version_max = s('beamng_version_max') ?? ''
  f.beammp_version_min = s('beammp_version_min') ?? ''

  const mp = s('multiplayer_scope')
  if (mp && (MULTIPLAYER_SCOPES as readonly string[]).includes(mp)) {
    f.multiplayer_scope = mp as FormState['multiplayer_scope']
  }
  f.server_download = s('server_download') ?? ''

  const resources = raw.resources
  if (resources && typeof resources === 'object') {
    const r = resources as Record<string, unknown>
    f.homepage = asString(r.homepage) ?? ''
    f.repository = asString(r.repository) ?? ''
    f.bugtracker = asString(r.bugtracker) ?? ''
    f.beamng_resource = asString(r.beamng_resource) ?? ''
    f.beammp_forum = asString(r.beammp_forum) ?? ''
  }

  f.depends = asRelationships(raw.depends)
  f.recommends = asRelationships(raw.recommends)
  f.suggests = asRelationships(raw.suggests)
  f.supports = asRelationships(raw.supports)
  f.conflicts = asRelationships(raw.conflicts)
  f.provides = asStringArray(raw.provides)
  f.install = asInstall(raw.install)
  f.kref = s('$kref') ?? ''
  f.comment = s('comment') ?? ''
  return f
}
