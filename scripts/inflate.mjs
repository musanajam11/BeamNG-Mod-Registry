#!/usr/bin/env node
/**
 * inflate.mjs — NetBeamMod inflator.
 *
 * Reads .netbeammod template files, fetches release metadata from upstream
 * sources (GitHub), and generates .beammod files for new versions automatically.
 *
 * This is the BeamNG-Mod-Registry equivalent of CKAN's NetKAN inflator.
 *
 * Usage:
 *   node scripts/inflate.mjs                    # Process all templates
 *   node scripts/inflate.mjs --dry-run           # Show what would be generated
 *   node scripts/inflate.mjs --id gta_radio      # Process specific mod only
 *   node scripts/inflate.mjs --no-hash           # Skip download+hash (metadata only)
 *   node scripts/inflate.mjs --cookie 'xf_session=abc123'  # BeamNG.com auth cookie
 *
 * Environment:
 *   GITHUB_TOKEN — optional, raises rate limit from 60/hr to 5000/hr
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'fs'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const NETBEAMMOD_DIR = join(ROOT, 'netbeammod')
const MODS_DIR = join(ROOT, 'mods')
const HEALTH_FILE = join(NETBEAMMOD_DIR, '.health.json')

// Number of consecutive failed checks before a template is auto-purged.
// At the default daily cron schedule this is roughly N days of upstream-gone
// before we consider the mod permanently dead. Override via env if needed.
const PURGE_THRESHOLD = Math.max(1, parseInt(process.env.PURGE_THRESHOLD || '5', 10))

// --- CLI ---
const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const NO_HASH = args.includes('--no-hash')
const FORCE = args.includes('--force')
const idFlagIdx = args.indexOf('--id')
const FILTER_ID = idFlagIdx !== -1 ? args[idFlagIdx + 1] : null
const cookieIdx = args.indexOf('--cookie')
const BEAMNG_COOKIE = cookieIdx !== -1 ? args[cookieIdx + 1] : (process.env.BEAMNG_COOKIE || '')
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''

const GITHUB_HEADERS = {
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'BeamNG-Mod-Registry-Inflator/1.0',
  ...(GITHUB_TOKEN ? { 'Authorization': `Bearer ${GITHUB_TOKEN}` } : {})
}

// ─── Source Fetchers ─────────────────────────────────────────────────────────

/**
 * Fetch all releases from a GitHub repository.
 * Paginates automatically (100 per page).
 */
async function fetchGitHubReleases(owner, repo) {
  const releases = []
  let page = 1
  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`
    const res = await fetch(url, { headers: GITHUB_HEADERS })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = await res.json()
    if (data.length === 0) break
    releases.push(...data)
    if (data.length < 100) break
    page++
  }
  return releases
}

/**
 * Fetch mod info from BeamNG.com/resources (community mod portal).
 *
 * The BeamNG.com resources section is powered by XenForo's Resource Manager.
 * We scrape the resource page to extract version and download info since there's
 * no public API. The resource URL pattern is:
 *   https://www.beamng.com/resources/{slug}.{id}/
 *   https://www.beamng.com/resources/{id}/download   (direct download)
 *   https://www.beamng.com/resources/{id}/history     (version history)
 *
 * Returns an array of "release-like" objects compatible with the GitHub pipeline.
 */
async function fetchBeamNGResource(resourceId) {
  const headers = {
    'User-Agent': 'BeamNG-Mod-Registry-Inflator/1.0',
    ...(BEAMNG_COOKIE ? { 'Cookie': BEAMNG_COOKIE } : {})
  }

  // Fetch the resource page to get current version + title
  const pageUrl = `https://www.beamng.com/resources/${resourceId}/`
  const res = await fetch(pageUrl, { headers, redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`BeamNG.com ${res.status} for resource ${resourceId}`)
  }
  const html = await res.text()

  // Extract current version from the page
  // XenForo pattern: <span class="muted">Version:</span> <span>X.Y.Z</span>
  // Also: <li class="resourceInfo"> ... Version: X.Y.Z
  const versionMatch = html.match(/Version:\s*<\/span>\s*<span[^>]*>([^<]+)</) ||
                        html.match(/Version:\s*([0-9][A-Za-z0-9._-]*)/) ||
                        html.match(/"version"\s*:\s*"([^"]+)"/)

  if (!versionMatch) {
    console.warn(`  ⚠ Could not extract version from BeamNG.com resource ${resourceId} — skipping`)
    return []
  }
  const version = versionMatch[1].trim()

  // Extract title
  const titleMatch = html.match(/<h1[^>]*class="[^"]*resourceTitle[^"]*"[^>]*>([^<]+)</) ||
                     html.match(/<title>([^|<]+)/)
  const title = titleMatch ? titleMatch[1].trim() : null

  // The download URL for BeamNG.com resources
  const downloadUrl = `https://www.beamng.com/resources/${resourceId}/download`

  return [{
    tag_name: version,
    draft: false,
    prerelease: false,
    published_at: null,
    assets: [{
      name: `resource-${resourceId}.zip`,
      browser_download_url: downloadUrl,
      size: 0  // Unknown until downloaded
    }],
    _beamng_title: title,
    _beamng_resource_id: resourceId
  }]
}

// ─── Transformers ────────────────────────────────────────────────────────────

/** Extract a clean version string from a git tag. */
function extractVersion(tag, template) {
  let version = tag
  // Strip leading 'v' (default: true)
  if (template.$version_strip_v !== false && /^v\d/.test(version)) {
    version = version.slice(1)
  }
  // Apply regex transform if specified
  if (template.$version_transform) {
    const { match, replace } = template.$version_transform
    version = version.replace(new RegExp(match), replace)
  }
  return version
}

/** Pick the correct download asset from a release. */
function findAsset(release, template) {
  const assets = release.assets || []
  if (assets.length === 0) return null

  // Use $filter_asset regex if provided
  if (template.$filter_asset) {
    const re = new RegExp(template.$filter_asset)
    return assets.find(a => re.test(a.name)) || null
  }

  // Default: first .zip asset, or first asset
  return assets.find(a => a.name.endsWith('.zip')) || assets[0]
}

/**
 * Download a file (streaming) and compute its SHA256 hash and size.
 * Does NOT buffer the entire file in memory.
 */
async function computeDownloadHash(url) {
  const hdrs = {
    'User-Agent': 'BeamNG-Mod-Registry-Inflator/1.0',
    ...(GITHUB_TOKEN ? { 'Authorization': `Bearer ${GITHUB_TOKEN}` } : {}),
    ...(BEAMNG_COOKIE && url.includes('beamng.com') ? { 'Cookie': BEAMNG_COOKIE } : {})
  }
  const res = await fetch(url, { headers: hdrs, redirect: 'follow' })
  if (!res.ok) throw new Error(`Download failed: ${res.status} for ${url}`)

  const hash = createHash('sha256')
  let size = 0

  // Stream via Web ReadableStream reader
  const reader = res.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
    size += value.length
  }

  return { sha256: hash.digest('hex'), size }
}

// ─── Template Processing ─────────────────────────────────────────────────────

/** Parse a $kref source reference. */
function parseKref(kref) {
  const gh = kref.match(/^#\/github\/([^/]+)\/(.+)$/)
  if (gh) return { source: 'github', owner: gh[1], repo: gh[2] }

  const beamng = kref.match(/^#\/beamng\/(\d+)$/)
  if (beamng) return { source: 'beamng', resourceId: beamng[1] }

  throw new Error(`Unsupported $kref format: "${kref}" — expected #/github/{owner}/{repo} or #/beamng/{resource_id}`)
}

/** Remove $-prefixed fields (template directives) from the output. */
function stripDollarFields(obj) {
  const clean = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith('$')) clean[k] = v
  }
  return clean
}

/** Find all .netbeammod template files. */
function findTemplates() {
  if (!existsSync(NETBEAMMOD_DIR)) return []
  return readdirSync(NETBEAMMOD_DIR)
    .filter(f => f.endsWith('.netbeammod'))
    .map(f => join(NETBEAMMOD_DIR, f))
}

/**
 * Process a single .netbeammod template:
 * - Fetch releases from the source
 * - For each new release, download asset, compute hash, generate .beammod
 */
async function inflateTemplate(templatePath) {
  const template = JSON.parse(readFileSync(templatePath, 'utf-8'))
  const id = template.identifier

  if (FILTER_ID && id !== FILTER_ID) {
    return { id, skipped: true, newVersions: 0 }
  }

  console.log(`\n▸ ${id}`)

  if (!template.$kref) {
    console.log('  ⚠ No $kref — skipping')
    return { id, skipped: true, newVersions: 0 }
  }

  const kref = parseKref(template.$kref)
  console.log(`  Source: ${kref.source} → ${kref.source === 'github' ? `${kref.owner}/${kref.repo}` : `resource ${kref.resourceId}`}`)

  // Fetch releases based on source type
  let releases
  try {
    if (kref.source === 'github') {
      releases = await fetchGitHubReleases(kref.owner, kref.repo)
    } else if (kref.source === 'beamng') {
      releases = await fetchBeamNGResource(kref.resourceId)
    }
  } catch (err) {
    // Treat upstream 404 (resource removed/unpublished) as a warning, not a fatal error.
    // Surface a `gone: true` flag so the main loop can track consecutive failures
    // and eventually auto-purge the template after PURGE_THRESHOLD streaks.
    if (/\b404\b/.test(err.message)) {
      console.warn(`  ⚠ ${err.message} — upstream resource gone, skipping`)
      return { id, skipped: true, newVersions: 0, warning: err.message, gone: true }
    }
    console.error(`  ✗ ${err.message}`)
    return { id, skipped: false, newVersions: 0, error: err.message }
  }
  console.log(`  Releases: ${releases.length} total`)

  // Filter out drafts; optionally include prereleases
  const filtered = releases.filter(r => {
    if (r.draft) return false
    if (r.prerelease && !template.$include_prerelease) return false
    return true
  })
  console.log(`  Eligible: ${filtered.length} (excluding drafts${template.$include_prerelease ? '' : ' and prereleases'})`)

  const maxReleases = template.$max_releases || 10
  let newVersions = 0

  for (const release of filtered.slice(0, maxReleases)) {
    const version = extractVersion(release.tag_name, template)
    const modDir = join(MODS_DIR, id)
    const outFile = join(modDir, `${id}-${version}.beammod`)

    // Skip existing versions (idempotent) unless --force
    if (existsSync(outFile) && !FORCE) {
      console.log(`  · ${version} — exists`)
      continue
    }

    // Find the download asset
    const asset = findAsset(release, template)
    if (!asset) {
      console.log(`  ⚠ ${version} — no matching asset`)
      continue
    }

    if (DRY_RUN) {
      console.log(`  → ${version} — would generate (${asset.name}, ${(asset.size / 1024 / 1024).toFixed(1)} MB)`)
      newVersions++
      continue
    }

    // Build the .beammod metadata
    const beammod = {
      ...stripDollarFields(template),
      version,
      download: asset.browser_download_url,
    }

    if (NO_HASH) {
      console.log(`  ⏭ ${version} — skipping download (--no-hash)`)
    } else {
      console.log(`  ⬇ ${version} — downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB) ...`)

      // Download and hash
      let hashResult
      try {
        hashResult = await computeDownloadHash(asset.browser_download_url)
      } catch (err) {
        console.error(`  ✗ ${version} download failed: ${err.message}`)
        continue
      }
      console.log(`    SHA256: ${hashResult.sha256}`)
      beammod.download_hash = { sha256: hashResult.sha256 }
      beammod.download_size = hashResult.size
    }

    // Set release_date from GitHub
    if (release.published_at) {
      beammod.release_date = release.published_at.split('T')[0]
    }

    // Set release_status from prerelease flag
    if (release.prerelease && !beammod.release_status) {
      beammod.release_status = 'testing'
    }

    // Auto-set resources from $kref source
    if (!beammod.resources) {
      beammod.resources = {}
    }
    if (kref.source === 'github' && !beammod.resources.repository) {
      beammod.resources.repository = `https://github.com/${kref.owner}/${kref.repo}`
    }
    if (kref.source === 'beamng' && !beammod.resources.beamng_resource) {
      beammod.resources.beamng_resource = `https://www.beamng.com/resources/${kref.resourceId}/`
    }

    // Mark manually-curated entries as verified. GitHub-sourced templates
    // are always verified; for other sources, honor an explicit
    // `x_verified: true` set in the template body (e.g. mods promoted via
    // the web UI that have been admin-reviewed).
    beammod.x_verified = kref.source === 'github' || template.x_verified === true

    // Write the .beammod file
    mkdirSync(modDir, { recursive: true })
    writeFileSync(outFile, JSON.stringify(beammod, null, 2) + '\n', 'utf-8')
    console.log(`  ✓ ${version} — generated`)
    newVersions++
  }

  const warning = kref.source === 'beamng' && releases.length === 0
  return { id, skipped: false, newVersions, warning }
}

// ─── Health tracking (self-healing) ──────────────────────────────────────────

/**
 * Load the persisted health-state map from `netbeammod/.health.json`.
 * Keyed by template basename (e.g. "etk-c-series-2004-2011.netbeammod").
 * Each entry: { identifier, kref, consecutiveFailures, firstFailure, lastFailure, lastError }.
 */
function loadHealth() {
  if (!existsSync(HEALTH_FILE)) return {}
  try {
    return JSON.parse(readFileSync(HEALTH_FILE, 'utf-8'))
  } catch (err) {
    console.warn(`⚠ Could not parse ${HEALTH_FILE}: ${err.message} — starting fresh`)
    return {}
  }
}

/** Persist health state, omitting entries with no active failure streak. */
function saveHealth(state) {
  const clean = {}
  for (const [k, v] of Object.entries(state)) {
    if (v && v.consecutiveFailures > 0) clean[k] = v
  }
  if (Object.keys(clean).length === 0) {
    if (existsSync(HEALTH_FILE)) {
      try { unlinkSync(HEALTH_FILE) } catch {}
    }
    return
  }
  writeFileSync(HEALTH_FILE, JSON.stringify(clean, null, 2) + '\n', 'utf-8')
}

/**
 * Permanently remove a template and its generated mod artefacts.
 * Used after PURGE_THRESHOLD consecutive 404s confirm the upstream is dead.
 */
function purgeTemplate(templatePath, identifier) {
  const removed = []
  try {
    if (existsSync(templatePath)) {
      unlinkSync(templatePath)
      removed.push(`netbeammod/${basename(templatePath)}`)
    }
  } catch (err) {
    console.warn(`  ⚠ Failed to remove ${templatePath}: ${err.message}`)
  }
  const modDir = join(MODS_DIR, identifier)
  if (existsSync(modDir)) {
    try {
      rmSync(modDir, { recursive: true, force: true })
      removed.push(`mods/${identifier}/`)
    } catch (err) {
      console.warn(`  ⚠ Failed to remove ${modDir}: ${err.message}`)
    }
  }
  return removed
}

// ─── Main ────────────────────────────────────────────────────────────────────

const templates = findTemplates()
if (templates.length === 0) {
  console.log('No .netbeammod files found in netbeammod/')
  process.exit(0)
}

// Deduplicate: when multiple templates share an identifier, prefer github over beamng
const byId = new Map()
for (const tpl of templates) {
  const data = JSON.parse(readFileSync(tpl, 'utf-8'))
  const id = data.identifier
  const kref = data.$kref ?? ''
  const source = kref.startsWith('#/github/') ? 'github' : kref.startsWith('#/beamng/') ? 'beamng' : 'unknown'
  const existing = byId.get(id)
  if (existing) {
    // GitHub source takes priority over BeamNG
    if (source === 'github' && existing.source !== 'github') {
      console.log(`⚠ Duplicate identifier "${id}": ${basename(tpl)} (github) supersedes ${basename(existing.path)} (${existing.source})`)
      byId.set(id, { path: tpl, source })
    } else if (source !== 'github' && existing.source === 'github') {
      console.log(`⚠ Duplicate identifier "${id}": ${basename(existing.path)} (github) supersedes ${basename(tpl)} (${source})`)
    } else {
      console.log(`⚠ Duplicate identifier "${id}": ${basename(tpl)} and ${basename(existing.path)} — using first`)
    }
  } else {
    byId.set(id, { path: tpl, source })
  }
}
const deduped = Array.from(byId.values()).map(v => v.path)

console.log(`Found ${templates.length} template(s)${deduped.length < templates.length ? ` (${deduped.length} after dedup)` : ''}`)
if (DRY_RUN) console.log('(dry-run mode — no files will be written)')
if (!GITHUB_TOKEN) console.log('(tip: set GITHUB_TOKEN to avoid API rate limits)')

let totalNew = 0
let totalErrors = 0
let totalWarnings = 0
let totalPurged = 0
const purgedSummary = []

const health = loadHealth()
const nowIso = new Date().toISOString()
// Map identifier -> template path so we can purge by id later.
const idToPath = new Map()
for (const [id, v] of byId.entries()) idToPath.set(id, v.path)

for (const tpl of deduped) {
  const tplKey = basename(tpl)
  try {
    const result = await inflateTemplate(tpl)
    totalNew += result.newVersions
    if (result.error) totalErrors++
    if (result.warning) totalWarnings++

    if (result.gone) {
      // Upstream returned 404 — record (or extend) the failure streak.
      const prev = health[tplKey] || { consecutiveFailures: 0, firstFailure: nowIso }
      health[tplKey] = {
        identifier: result.id,
        consecutiveFailures: prev.consecutiveFailures + 1,
        firstFailure: prev.firstFailure || nowIso,
        lastFailure: nowIso,
        lastError: result.warning || result.error || '404'
      }
      const streak = health[tplKey].consecutiveFailures
      console.log(`  ↳ failure streak: ${streak}/${PURGE_THRESHOLD}`)
    } else if (!result.error) {
      // Successful contact (even if no new versions / no releases) — clear any prior streak.
      if (health[tplKey]) {
        console.log(`  ↳ recovered — clearing previous failure streak`)
        delete health[tplKey]
      }
    }
    // result.error (non-404) does NOT reset the streak but also doesn't extend
    // the gone-counter; transient errors are simply reported and retried tomorrow.
  } catch (err) {
    console.error(`\n✗ Fatal error processing ${tpl}: ${err.message}`)
    totalErrors++
  }
}

// ─── Self-heal: purge templates that have been gone for PURGE_THRESHOLD runs ──
for (const [tplKey, entry] of Object.entries(health)) {
  if (entry.consecutiveFailures < PURGE_THRESHOLD) continue
  const tplPath = idToPath.get(entry.identifier) || join(NETBEAMMOD_DIR, tplKey)
  console.log(`\n☠ Purging "${entry.identifier}" — upstream gone for ${entry.consecutiveFailures} consecutive runs (since ${entry.firstFailure})`)
  if (DRY_RUN) {
    console.log(`  (dry-run — would remove netbeammod/${tplKey} and mods/${entry.identifier}/)`)
    totalPurged++
    purgedSummary.push(entry.identifier)
    continue
  }
  const removed = purgeTemplate(tplPath, entry.identifier)
  for (const r of removed) console.log(`  ✗ removed ${r}`)
  delete health[tplKey]
  totalPurged++
  purgedSummary.push(entry.identifier)
}

if (!DRY_RUN) saveHealth(health)

console.log(`\n━━━ Summary ━━━`)
console.log(`Templates: ${templates.length}`)
console.log(`New versions: ${totalNew}`)
if (totalWarnings > 0) console.log(`Warnings: ${totalWarnings}`)
if (totalErrors > 0) console.log(`Errors: ${totalErrors}`)
if (totalPurged > 0) {
  console.log(`Purged (upstream gone): ${totalPurged}`)
  for (const id of purgedSummary) console.log(`  - ${id}`)
}
if (DRY_RUN) console.log('(dry-run — nothing was written)')

process.exit(totalErrors > 0 ? 1 : 0)
