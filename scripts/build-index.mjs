#!/usr/bin/env node
/**
 * build-index.mjs — Builds registry-index.json from all .beammod files,
 * then compresses it into registry-index.json.gz for distribution via GitHub Releases.
 *
 * Usage: node scripts/build-index.mjs
 * Output: dist/registry-index.json, dist/registry-index.json.gz
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createGzip } from 'zlib'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MODS_DIR = join(ROOT, 'mods')
const DIST_DIR = join(ROOT, 'dist')

function findBeammodFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) {
      results.push(...findBeammodFiles(full))
    } else if (entry.endsWith('.beammod')) {
      results.push(full)
    }
  }
  return results
}

// Build index: group all versions by identifier
const files = findBeammodFiles(MODS_DIR)
const index = {}

for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf-8'))
  const id = data.identifier
  if (!index[id]) {
    index[id] = { identifier: id, versions: [] }
  }
  index[id].versions.push(data)
}

// Parse epoch:version format (Debian-style)
function parseEpochVersion(v) {
  const colonIdx = v.indexOf(':')
  if (colonIdx > 0) {
    const epoch = parseInt(v.slice(0, colonIdx), 10)
    return { epoch: isNaN(epoch) ? 0 : epoch, version: v.slice(colonIdx + 1) }
  }
  return { epoch: 0, version: v }
}

function compareVersionParts(a, b) {
  const ap = a.split(/[.\-+_]/).map(p => { const n = parseInt(p, 10); return isNaN(n) ? 0 : n })
  const bp = b.split(/[.\-+_]/).map(p => { const n = parseInt(p, 10); return isNaN(n) ? 0 : n })
  const len = Math.max(ap.length, bp.length)
  for (let i = 0; i < len; i++) {
    const av = ap[i] ?? 0
    const bv = bp[i] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

function compareVersions(a, b) {
  const pa = parseEpochVersion(a)
  const pb = parseEpochVersion(b)
  if (pa.epoch !== pb.epoch) return pa.epoch - pb.epoch
  return compareVersionParts(pa.version, pb.version)
}

// Sort versions newest-first using proper version comparison
for (const mod of Object.values(index)) {
  mod.versions.sort((a, b) => compareVersions(b.version, a.version))
}

const registryIndex = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  mod_count: Object.keys(index).length,
  version_count: files.length,
  mods: index
}

mkdirSync(DIST_DIR, { recursive: true })

// Write JSON
const jsonPath = join(DIST_DIR, 'registry-index.json')
writeFileSync(jsonPath, JSON.stringify(registryIndex, null, 2), 'utf-8')
console.log(`✓ ${jsonPath} (${Object.keys(index).length} mods, ${files.length} versions)`)

// Write gzipped version
const gzPath = join(DIST_DIR, 'registry-index.json.gz')
const jsonBuffer = Buffer.from(JSON.stringify(registryIndex))
await pipeline(
  Readable.from(jsonBuffer),
  createGzip({ level: 9 }),
  createWriteStream(gzPath)
)
console.log(`✓ ${gzPath}`)
