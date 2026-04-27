// Shared form state shape, defaults, and payload builder for the submission form.
export const KINDS = ['package', 'metapackage', 'dlc'] as const
export const MOD_TYPES = [
  'vehicle', 'map', 'skin', 'ui_app', 'sound',
  'license_plate', 'scenario', 'automation', 'other',
] as const
export const RELEASE_STATUSES = ['stable', 'testing', 'development'] as const
export const MULTIPLAYER_SCOPES = ['client', 'server', 'both'] as const

export interface Relationship {
  identifier: string
  min_version?: string
  max_version?: string
}

export interface InstallDirective {
  match_type: 'file' | 'find' | 'find_regexp'
  match_value: string
  install_to: string
  as?: string
  filter?: string
  filter_regexp?: string
  include_only?: string
  include_only_regexp?: string
  find_matches_files?: boolean
}

export interface FormState {
  identifier: string
  name: string
  abstract: string
  author: string
  version: string
  license: string
  kind: typeof KINDS[number]
  mod_type: string | null
  download: string
  download_size: number | null
  install_size: number | null
  thumbnail: string
  tags: string[]
  description: string
  release_status: typeof RELEASE_STATUSES[number]
  release_date: string
  beamng_version: string
  beamng_version_min: string
  beamng_version_max: string
  beammp_version_min: string
  multiplayer_scope: typeof MULTIPLAYER_SCOPES[number]
  server_download: string
  homepage: string
  repository: string
  bugtracker: string
  beamng_resource: string
  beammp_forum: string
  depends: Relationship[]
  recommends: Relationship[]
  suggests: Relationship[]
  supports: Relationship[]
  conflicts: Relationship[]
  provides: string[]
  install: InstallDirective[]
  kref: string
  comment: string
}

export const DEFAULT_FORM: FormState = {
  identifier: '', name: '', abstract: '', author: '', version: '1.0.0', license: 'MIT',
  kind: 'package', mod_type: 'vehicle',
  download: '', download_size: null, install_size: null,
  thumbnail: '', tags: [], description: '',
  release_status: 'stable', release_date: '',
  beamng_version: '', beamng_version_min: '', beamng_version_max: '', beammp_version_min: '',
  multiplayer_scope: 'client', server_download: '',
  homepage: '', repository: '', bugtracker: '', beamng_resource: '', beammp_forum: '',
  depends: [], recommends: [], suggests: [], supports: [], conflicts: [], provides: [],
  install: [], kref: '', comment: '',
}

export type Updater = <K extends keyof FormState>(key: K, value: FormState[K]) => void

function rel(list: Relationship[]) {
  return list
    .filter((r) => r.identifier.trim())
    .map((r) => {
      const o: Record<string, string> = { identifier: r.identifier.trim() }
      if (r.min_version) o.min_version = r.min_version
      if (r.max_version) o.max_version = r.max_version
      return o
    })
}

export function buildPayload(f: FormState): Record<string, unknown> {
  const p: Record<string, unknown> = {
    spec_version: 1,
    identifier: f.identifier,
    name: f.name,
    abstract: f.abstract,
    author: f.author,
    version: f.version,
    license: f.license,
  }
  if (f.kind !== 'package') p.kind = f.kind
  if (f.mod_type) p.mod_type = f.mod_type
  if (f.download) p.download = f.download
  if (f.download_size != null) p.download_size = f.download_size
  if (f.install_size != null) p.install_size = f.install_size
  if (f.thumbnail) p.thumbnail = f.thumbnail
  if (f.tags.length) p.tags = f.tags
  if (f.description) p.description = f.description
  if (f.release_status !== 'stable') p.release_status = f.release_status
  if (f.release_date) p.release_date = f.release_date
  if (f.beamng_version) p.beamng_version = f.beamng_version
  if (f.beamng_version_min) p.beamng_version_min = f.beamng_version_min
  if (f.beamng_version_max) p.beamng_version_max = f.beamng_version_max
  if (f.beammp_version_min) p.beammp_version_min = f.beammp_version_min
  if (f.multiplayer_scope !== 'client') p.multiplayer_scope = f.multiplayer_scope
  if (f.server_download) p.server_download = f.server_download

  const resources: Record<string, string> = {}
  if (f.homepage) resources.homepage = f.homepage
  if (f.repository) resources.repository = f.repository
  if (f.bugtracker) resources.bugtracker = f.bugtracker
  if (f.beamng_resource) resources.beamng_resource = f.beamng_resource
  if (f.beammp_forum) resources.beammp_forum = f.beammp_forum
  if (Object.keys(resources).length) p.resources = resources

  if (f.depends.length) p.depends = rel(f.depends)
  if (f.recommends.length) p.recommends = rel(f.recommends)
  if (f.suggests.length) p.suggests = rel(f.suggests)
  if (f.supports.length) p.supports = rel(f.supports)
  if (f.conflicts.length) p.conflicts = rel(f.conflicts)
  if (f.provides.length) p.provides = f.provides

  if (f.install.length) {
    p.install = f.install
      .filter((i) => i.match_value.trim() && i.install_to.trim())
      .map((i) => {
        const o: Record<string, unknown> = {
          [i.match_type]: i.match_value.trim(),
          install_to: i.install_to.trim(),
        }
        if (i.as) o.as = i.as
        if (i.filter) o.filter = i.filter
        if (i.filter_regexp) o.filter_regexp = i.filter_regexp
        if (i.include_only) o.include_only = i.include_only
        if (i.include_only_regexp) o.include_only_regexp = i.include_only_regexp
        if (i.find_matches_files) o.find_matches_files = true
        return o
      })
  }
  if (f.kref) p.$kref = f.kref
  if (f.comment) p.comment = f.comment
  return p
}
