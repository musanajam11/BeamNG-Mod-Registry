#!/usr/bin/env node
/**
 * verify-downloads.mjs — Download verification for .beammod files.
 *
 * Fetches each download URL, streams the file to compute SHA256, and verifies
 * it matches the declared download_hash. Also verifies download_size if present.
 *
 * Usage:
 *   node scripts/verify-downloads.mjs                          # Verify all
 *   node scripts/verify-downloads.mjs --fix                    # Auto-fix size/hash
 *   node scripts/verify-downloads.mjs --changed-only           # Only verify new/modified .beammod files (CI)
 *   node scripts/verify-downloads.mjs --id gta_radio           # Verify specific mod
 *
 * Environment:
 *   GITHUB_TOKEN — optional, needed for GitHub release asset URLs
 *
 * Exit codes:
 *   0 — all downloads verified
 *   1 — one or more verification failures
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MODS_DIR = join(ROOT, 'mods')

const args = process.argv.slice(2)
const FIX_MODE = args.includes('--fix')
const CHANGED_ONLY = args.includes('--changed-only')
const idFlagIdx = args.indexOf('--id')
const FILTER_ID = idFlagIdx !== -1 ? args[idFlagIdx + 1] : null
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''

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

/** Get list of changed .beammod files from git diff (for PR validation). */
function getChangedBeammodFiles() {
  try {
    const output = execSync('git diff --name-only --diff-filter=ACMR origin/main...HEAD', {
      cwd: ROOT,
      encoding: 'utf-8'
    }).trim()
    if (!output) return []
    return output
      .split('\n')
      .filter(f => f.endsWith('.beammod'))
      .map(f => join(ROOT, f))
  } catch {
    // Fallback: diff against HEAD~1
    try {
      const output = execSync('git diff --name-only --diff-filter=ACMR HEAD~1', {
        cwd: ROOT,
        encoding: 'utf-8'
      }).trim()
      if (!output) return []
      return output
        .split('\n')
        .filter(f => f.endsWith('.beammod'))
        .map(f => join(ROOT, f))
    } catch {
      return []
    }
  }
}

/** Stream-download a URL and compute SHA256 + size. */
async function fetchAndHash(url) {
  const headers = {
    'User-Agent': 'BeamNG-Mod-Registry-Verifier/1.0',
    ...(GITHUB_TOKEN ? { 'Authorization': `Bearer ${GITHUB_TOKEN}` } : {})
  }

  const res = await fetch(url, { headers, redirect: 'follow' })
  if (!res.ok) {
    return { error: `HTTP ${res.status}`, reachable: false, sha256: null, size: 0 }
  }

  const hash = createHash('sha256')
  let size = 0
  const reader = res.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
    size += value.length
  }

  return { error: null, reachable: true, sha256: hash.digest('hex'), size }
}

/** Verify a single download URL against declared hash/size. */
async function verifyDownload(url, declaredHash, declaredSize, label) {
  const issues = []
  const result = await fetchAndHash(url)

  if (!result.reachable) {
    issues.push({ field: 'download', severity: 'error', msg: `Dead link: ${result.error} — ${url}` })
    return { issues, actual: result }
  }

  // Verify hash
  if (declaredHash?.sha256) {
    if (result.sha256 !== declaredHash.sha256.toLowerCase()) {
      issues.push({
        field: 'download_hash',
        severity: 'error',
        msg: `SHA256 mismatch for ${label}: declared ${declaredHash.sha256}, actual ${result.sha256}`
      })
    }
  } else {
    issues.push({
      field: 'download_hash',
      severity: 'warning',
      msg: `No download_hash declared for ${label} — actual SHA256: ${result.sha256}`
    })
  }

  // Verify size
  if (declaredSize !== undefined && declaredSize !== null) {
    if (result.size !== declaredSize) {
      issues.push({
        field: 'download_size',
        severity: 'warning',
        msg: `Size mismatch for ${label}: declared ${declaredSize}, actual ${result.size}`
      })
    }
  }

  return { issues, actual: result }
}

// ─── Main ────────────────────────────────────────────────────────────────────

let files
if (CHANGED_ONLY) {
  files = getChangedBeammodFiles()
  if (files.length === 0) {
    console.log('No changed .beammod files to verify')
    process.exit(0)
  }
} else {
  files = findBeammodFiles(MODS_DIR)
}

if (FILTER_ID) {
  files = files.filter(f => {
    const parentDir = f.split(/[\\/]/).slice(-2, -1)[0]
    return parentDir === FILTER_ID
  })
}

if (files.length === 0) {
  console.log('No .beammod files to verify')
  process.exit(0)
}

console.log(`Verifying downloads for ${files.length} file(s)...\n`)

let totalErrors = 0
let totalWarnings = 0
let totalVerified = 0

for (const file of files) {
  const rel = relative(ROOT, file)
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    console.error(`✗ ${rel}: Invalid JSON — skipping`)
    totalErrors++
    continue
  }

  // Skip metapackages/DLC without downloads
  if (data.kind === 'metapackage' || data.kind === 'dlc') {
    console.log(`· ${rel}: ${data.kind} — no download to verify`)
    continue
  }

  const downloads = Array.isArray(data.download) ? data.download : (data.download ? [data.download] : [])
  if (downloads.length === 0) {
    console.log(`· ${rel}: No download URL`)
    continue
  }

  let fileHasError = false
  let fileModified = false

  // Verify main download(s)
  for (const url of downloads) {
    console.log(`  ⬇ ${rel}: ${url}`)
    const { issues, actual } = await verifyDownload(url, data.download_hash, data.download_size, 'download')

    for (const issue of issues) {
      if (issue.severity === 'error') {
        console.error(`  ✗ ${issue.msg}`)
        totalErrors++
        fileHasError = true
      } else {
        console.warn(`  ⚠ ${issue.msg}`)
        totalWarnings++
      }
    }

    if (!fileHasError && actual.reachable && FIX_MODE) {
      // Auto-fix hash if missing or wrong
      if (!data.download_hash || data.download_hash.sha256?.toLowerCase() !== actual.sha256) {
        data.download_hash = { sha256: actual.sha256 }
        fileModified = true
      }
      // Auto-fix size
      if (data.download_size !== actual.size) {
        data.download_size = actual.size
        fileModified = true
      }
    }

    if (!fileHasError && actual.reachable) totalVerified++
  }

  // Verify server_download if present
  const serverDownloads = Array.isArray(data.server_download)
    ? data.server_download
    : (data.server_download ? [data.server_download] : [])

  for (const url of serverDownloads) {
    console.log(`  ⬇ ${rel} (server): ${url}`)
    const { issues, actual } = await verifyDownload(url, data.server_download_hash, null, 'server_download')

    for (const issue of issues) {
      if (issue.severity === 'error') {
        console.error(`  ✗ ${issue.msg}`)
        totalErrors++
        fileHasError = true
      } else {
        console.warn(`  ⚠ ${issue.msg}`)
        totalWarnings++
      }
    }

    if (!fileHasError && actual.reachable && FIX_MODE) {
      if (!data.server_download_hash || data.server_download_hash.sha256?.toLowerCase() !== actual.sha256) {
        data.server_download_hash = { sha256: actual.sha256 }
        fileModified = true
      }
    }

    if (!fileHasError && actual.reachable) totalVerified++
  }

  if (fileModified) {
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    console.log(`  ✎ ${rel}: auto-fixed`)
  }

  if (!fileHasError && !fileModified && downloads.length > 0) {
    console.log(`  ✓ ${rel}`)
  }
}

console.log(`\n━━━ Download Verification ━━━`)
console.log(`Files: ${files.length}`)
console.log(`Verified: ${totalVerified}`)
if (totalWarnings > 0) console.log(`Warnings: ${totalWarnings}`)
if (totalErrors > 0) console.log(`Errors: ${totalErrors}`)

process.exit(totalErrors > 0 ? 1 : 0)
