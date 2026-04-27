#!/usr/bin/env node
/**
 * backfill-thumbnails.mjs — Populate the `thumbnail` field on .beammod files
 * by scraping the Open Graph image from the linked BeamNG resource page.
 *
 * For each .beammod that has `resources.beamng_resource` but no `thumbnail`,
 * fetches the page, extracts <meta property="og:image" content="..."> and
 * writes it back to the file.
 *
 * Usage:
 *   node scripts/backfill-thumbnails.mjs                # backfill all missing
 *   node scripts/backfill-thumbnails.mjs --force        # overwrite existing thumbnails
 *   node scripts/backfill-thumbnails.mjs --id <id>      # single mod
 *   node scripts/backfill-thumbnails.mjs --dry-run      # report only, no writes
 *   node scripts/backfill-thumbnails.mjs --concurrency 4
 *
 * Exit codes: 0 ok, 1 if any fetch failed.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const MODS_DIR = join(ROOT, 'mods')

const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const DRY = args.includes('--dry-run')
const idIdx = args.indexOf('--id')
const FILTER_ID = idIdx !== -1 ? args[idIdx + 1] : null
const conIdx = args.indexOf('--concurrency')
const CONCURRENCY = conIdx !== -1 ? Math.max(1, parseInt(args[conIdx + 1], 10) || 4) : 4

function findBeammodFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...findBeammodFiles(full))
    else if (entry.endsWith('.beammod')) out.push(full)
  }
  return out
}

/**
 * Pull the best cover/screenshot image from a BeamNG resource page.
 *
 * Two high-res sources exist on a XenForo resource page:
 *   1. BBCode-rendered <img> tags inside the description ([IMG]url[/IMG] from
 *      the author — often externally hosted banners / cover art).
 *   2. <img src="data/attachments/NN/NNNNNN-hash.jpg"> — full-resolution
 *      screenshot gallery uploads.
 *
 * Plus a small but always-present source:
 *   3. <img class="resourceIcon" src="data/resource_icons/...">
 *
 * og:image / twitter:image only return the site logo, so we skip them.
 *
 * Strategy: scan the description block for the first usable <img>, falling
 * back to the first attachment, then the resourceIcon. Junk (avatars,
 * smilies, site chrome, the BeamNG logo) is filtered out.
 */
const JUNK_PATTERNS = [
  /(?:^|\/)avatars?\//i,
  /(?:^|\/)styles\/(?:default|uix)\//i,
  /(?:^|\/)oldicons\//i,
  /(?:^|\/)smilies\//i,
  /xenresource\/resource_icon\.png/i,
  /logo(?:_small|2)?\.(?:og\.)?png/i,
  /favicon/i,
  /discord\.png/i,
  /mceSmilie/i
]
const isJunk = (url) => !url || JUNK_PATTERNS.some(p => p.test(url))

function extractDescriptionBlock(html) {
  // XenForo resource overview is rendered inside <article class="resourceTabs"> /
  // <div class="resourceContent">. Fall back to the first messageText block.
  const candidates = [
    /<div[^>]+class=["'][^"']*\bresourceContent\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]+class=["']messageMeta|<\/article>)/i,
    /<blockquote[^>]+class=["'][^"']*\bmessageText\b[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i
  ]
  for (const re of candidates) {
    const m = html.match(re)
    if (m && m[1]) return m[1]
  }
  return html
}

function findImgs(block) {
  const out = []
  const re = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
  let m
  while ((m = re.exec(block)) !== null) out.push(m[1].trim())
  return out
}

function extractCoverImage(html) {
  const description = extractDescriptionBlock(html)
  // 1. First non-junk <img> inside the description (BBCode banner or attachment).
  for (const url of findImgs(description)) {
    if (!isJunk(url)) return url
  }
  // 2. First attachment anywhere on the page.
  const att = html.match(/<img[^>]+src=["'](data\/attachments\/[^"']+\.(?:jpg|jpeg|png|webp|gif))["']/i)
  if (att && att[1] && !isJunk(att[1])) return att[1]
  // 3. Resource icon — but skip the generic XenForo placeholder, which
  // appears on resources that never uploaded a custom icon.
  const icon = html.match(/<img[^>]+class=["'][^"']*\bresourceIcon\b[^"']*["'][^>]*\bsrc=["']([^"']+)["']/i)
                || html.match(/<img[^>]+\bsrc=["']([^"']+)["'][^>]*class=["'][^"']*\bresourceIcon\b[^"']*["']/i)
  if (icon && icon[1] && !isJunk(icon[1])) return icon[1]
  return null
}

async function fetchCoverImage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BeamNG-Mod-Registry-Thumb-Backfill/1.0)',
      'Accept': 'text/html,application/xhtml+xml'
    },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  const img = extractCoverImage(html)
  if (!img) throw new Error('no cover image found on page')
  // Resolve relative + protocol-relative URLs.
  // XenForo serves images with paths relative to the SITE ROOT (e.g.
  // "data/attachments/.../foo.jpg"), NOT the resource page path. Resolving
  // against the page URL would produce /resources/NNNNN/data/attachments/...
  // which 404s. Always resolve against the site origin.
  if (img.startsWith('//')) return 'https:' + img
  const u = new URL(url)
  const origin = `${u.protocol}//${u.host}`
  if (img.startsWith('/')) return origin + img
  if (!/^https?:\/\//i.test(img)) return `${origin}/${img.replace(/^\.?\//, '')}`
  return img
}

async function processOne(file) {
  const raw = readFileSync(file, 'utf-8')
  let json
  try { json = JSON.parse(raw) } catch (e) { return { file, status: 'parse_error', error: e.message } }

  if (FILTER_ID && json.identifier !== FILTER_ID) return { file, status: 'skipped' }
  if (json.thumbnail && !FORCE) return { file, status: 'has_thumbnail' }

  const resourceUrl = json?.resources?.beamng_resource
  if (!resourceUrl) return { file, status: 'no_resource' }

  try {
    const img = await fetchCoverImage(resourceUrl)
    if (!img) return { file, status: 'no_image', resourceUrl }
    if (DRY) return { file, status: 'would_write', img }
    json.thumbnail = img
    writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf-8')
    return { file, status: 'updated', img }
  } catch (e) {
    return { file, status: 'fetch_error', error: e.message, resourceUrl }
  }
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length)
  let idx = 0
  async function next() {
    while (true) {
      const i = idx++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next))
  return results
}

async function main() {
  const files = findBeammodFiles(MODS_DIR)
  console.log(`Scanning ${files.length} .beammod files (concurrency=${CONCURRENCY}, dry=${DRY}, force=${FORCE})`)

  let updated = 0, skipped = 0, errors = 0, hadAlready = 0, noResource = 0

  const results = await runPool(files, async (file, i) => {
    const r = await processOne(file)
    const rel = file.slice(ROOT.length + 1)
    switch (r.status) {
      case 'updated':
        updated++; console.log(`[${i + 1}/${files.length}] ✓ ${rel} -> ${r.img}`); break
      case 'would_write':
        updated++; console.log(`[${i + 1}/${files.length}] ~ ${rel} -> ${r.img} (dry)`); break
      case 'has_thumbnail':
        hadAlready++; break
      case 'no_resource':
        noResource++; break
      case 'skipped':
        skipped++; break
      case 'fetch_error':
      case 'parse_error':
      case 'no_image':
        errors++; console.warn(`[${i + 1}/${files.length}] ✗ ${rel} (${r.status}): ${r.error || ''} ${r.resourceUrl || ''}`); break
    }
    return r
  }, CONCURRENCY)

  console.log('\n--- Summary ---')
  console.log(`Updated:           ${updated}${DRY ? ' (dry-run)' : ''}`)
  console.log(`Already had thumb: ${hadAlready}`)
  console.log(`No resource link:  ${noResource}`)
  console.log(`Skipped (filter):  ${skipped}`)
  console.log(`Errors:            ${errors}`)
  process.exit(errors > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
