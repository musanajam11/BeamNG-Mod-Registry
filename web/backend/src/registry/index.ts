/**
 * Read-only index of the local registry on disk. Used to power the in-app
 * Registry Browser so authors can look up identifiers (e.g. when filling in
 * `depends`/`recommends`/`provides`).
 *
 * Layout assumed:
 *   <modsRoot>/<slug>/<slug>-<version>.beammod   (one or more .beammod JSON
 *                                                 files per folder, one per
 *                                                 published version)
 *
 * The index is rebuilt lazily on demand and cached for `CACHE_MS` so a user
 * hitting search rapidly doesn't pound the filesystem. We pick the latest
 * version per identifier for the listing; the detail endpoint returns the
 * full payload from that newest file plus the list of all versions seen.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.js'
import { fetchRemoteRegistry } from './remote.js'

export interface ModEntry {
  identifier: string
  name: string
  abstract?: string
  author?: string
  license?: string
  kind: string
  mod_type?: string
  version: string
  download?: string
  thumbnail?: string
  tags: string[]
  release_status?: string
  multiplayer_scope?: string
  /**
   * `x_verified: true` in the .beammod marks a manually-curated entry
   * (GitHub-sourced); `false` means it was autoscraped from the
   * BeamNG resources site. Used to highlight curated mods in the UI
   * and float them to the top of listings.
   */
  verified: boolean
  resources?: Record<string, unknown>
  raw: Record<string, unknown>
  versions: string[]
}

interface CacheShape {
  at: number
  entries: ModEntry[]
  byId: Map<string, ModEntry>
}

const CACHE_MS = 60_000
let cache: CacheShape | null = null

// Loose version compare — handles `1.0`, `1.0.3`, `1.0-beta`, etc. by
// splitting on `.` and `-`, treating numeric chunks as numbers and falling
// back to lexicographic on non-numeric chunks. Good enough to pick the
// "latest" published `.beammod` per identifier; precise semver isn't part
// of the registry contract.
function compareVersion(a: string, b: string): number {
  const split = (s: string) =>
    s.split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p))
  const pa = split(a)
  const pb = split(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i] ?? 0
    const xb = pb[i] ?? 0
    if (xa === xb) continue
    if (typeof xa === 'number' && typeof xb === 'number') return xa - xb
    return String(xa).localeCompare(String(xb))
  }
  return 0
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

async function build(): Promise<CacheShape> {
  const root = config.modsRoot
  const byId = new Map<string, ModEntry>()
  let folders: string[] = []
  try {
    folders = await fs.readdir(root)
  } catch {
    return { at: Date.now(), entries: [], byId }
  }

  await Promise.all(
    folders.map(async (folder) => {
      const folderPath = join(root, folder)
      let stat
      try {
        stat = await fs.stat(folderPath)
      } catch {
        return
      }
      if (!stat.isDirectory()) return
      let files: string[] = []
      try {
        files = await fs.readdir(folderPath)
      } catch {
        return
      }
      for (const file of files) {
        if (!file.endsWith('.beammod')) continue
        let json: Record<string, unknown>
        try {
          const text = await fs.readFile(join(folderPath, file), 'utf-8')
          json = JSON.parse(text) as Record<string, unknown>
        } catch {
          continue
        }
        const id = asString(json.identifier)
        if (!id) continue
        const ver = asString(json.version) ?? '0'
        const existing = byId.get(id)
        const isNewer = !existing || compareVersion(ver, existing.version) > 0
        if (isNewer) {
          byId.set(id, {
            identifier: id,
            name: asString(json.name) ?? id,
            abstract: asString(json.abstract),
            author: asString(json.author),
            license: asString(json.license),
            kind: asString(json.kind) ?? 'package',
            mod_type: asString(json.mod_type),
            version: ver,
            download: asString(json.download),
            thumbnail: asString(json.thumbnail),
            tags: Array.isArray(json.tags) ? json.tags.map((t) => String(t)) : [],
            release_status: asString(json.release_status),
            multiplayer_scope: asString(json.multiplayer_scope),
            verified: json.x_verified === true,
            resources:
              typeof json.resources === 'object' && json.resources !== null
                ? (json.resources as Record<string, unknown>)
                : undefined,
            raw: json,
            versions: existing ? [...existing.versions, ver] : [ver],
          })
        } else if (existing) {
          existing.versions.push(ver)
        }
      }
    })
  )

  // Dedupe + sort version lists, then sort entries by name.
  for (const m of byId.values()) {
    m.versions = Array.from(new Set(m.versions)).sort((a, b) => -compareVersion(a, b))
  }
  const entries = Array.from(byId.values()).sort((a, b) => {
    // Verified (manually-curated) entries float to the top so authors
    // see authoritative mods first when looking up identifiers.
    if (a.verified !== b.verified) return a.verified ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return { at: Date.now(), entries, byId }
}

export async function getRegistry(): Promise<CacheShape> {
  const now = Date.now()
  const ttl = config.registrySource === 'local' ? CACHE_MS : config.registryRefreshMs
  if (cache && now - cache.at < ttl) return cache

  // Resolve the source: explicit `local` or `remote`, or `auto` (default)
  // which prefers remote and falls back to local on failure.
  if (config.registrySource === 'local') {
    cache = await build()
    return cache
  }

  try {
    const entries = await fetchRemoteRegistry()
    const byId = new Map<string, ModEntry>()
    for (const e of entries) byId.set(e.identifier, e)
    cache = { at: now, entries, byId }
    return cache
  } catch (err) {
    if (config.registrySource === 'remote') {
      // Strict remote mode — surface the failure.
      throw err
    }
    // `auto` mode — log and fall back to local disk.
    // eslint-disable-next-line no-console
    console.warn('[registry] remote fetch failed, falling back to local mods/:', (err as Error).message)
    cache = await build()
    return cache
  }
}

export function invalidateRegistryCache(): void {
  cache = null
}

/**
 * Strip the bulky `raw` field for list responses; clients only need it for
 * the detail view.
 */
export function summarize(m: ModEntry): Omit<ModEntry, 'raw'> {
  const { raw: _raw, ...rest } = m
  return rest
}
