#!/usr/bin/env node
/**
 * seed-registry.mjs — Scrape BeamNG.com/resources listing pages
 * and generate .netbeammod templates for discovered mods.
 *
 * Run in small page chunks to be gentle on BeamNG.com servers:
 *
 *   node scripts/seed-registry.mjs --category land.3 --start 1 --end 5
 *   node scripts/seed-registry.mjs --category terrains-levels-maps.9 --start 1 --end 10
 *   node scripts/seed-registry.mjs --category sounds.13 --min-downloads 5000
 *   node scripts/seed-registry.mjs --dry-run --category land.3 --end 2
 *
 * Flags:
 *   --category <key>     Category to scrape (default: land.3). See --list-categories.
 *   --start <n>          Start page number (default: 1)
 *   --end <n>            End page number (default: 1)
 *   --delay <ms>         Delay between page fetches in ms (default: 2000)
 *   --min-downloads <n>  Skip mods below this download count (default: 1000)
 *   --dry-run            Preview without writing files
 *   --list-categories    Print available categories and exit
 */
import { writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const NETBEAMMOD_DIR = join(ROOT, 'netbeammod')

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : def
}
const flag = name => args.includes(`--${name}`)

const CATEGORY   = getArg('category', 'land.3')
const START_PAGE = +(getArg('start', '1'))
const END_PAGE   = +(getArg('end', '1'))
const DELAY_MS   = +(getArg('delay', '2000'))
const MIN_DL     = +(getArg('min-downloads', '1000'))
const DRY_RUN    = flag('dry-run')

// ─── Category Definitions ────────────────────────────────────────────────────

const CATEGORIES = {
  'land.3':                 { type: 'vehicle',       pages: 20,  label: 'Land Vehicles' },
  'air.4':                  { type: 'vehicle',       pages: 1,   label: 'Aircraft' },
  'props.5':                { type: 'other',         pages: 11,  label: 'Props' },
  'boats.6':                { type: 'vehicle',       pages: 1,   label: 'Boats' },
  'configurations.14':      { type: 'other',         pages: 53,  label: 'Configurations' },
  'mods-of-mods.7':         { type: 'other',         pages: 170, label: 'Mods of Mods' },
  'scenarios.8':            { type: 'scenario',      pages: 15,  label: 'Scenarios' },
  'terrains-levels-maps.9': { type: 'map',           pages: 45,  label: 'Maps' },
  'user-interface-apps.10': { type: 'ui_app',        pages: 9,   label: 'UI Apps' },
  'sounds.13':              { type: 'sound',         pages: 14,  label: 'Sounds' },
  'license-plates.15':      { type: 'license_plate', pages: 21,  label: 'License Plates' },
  'track-builder.17':       { type: 'other',         pages: 5,   label: 'Track Builder' },
  'skins.12':               { type: 'skin',          pages: 93,  label: 'Skins' },
}

if (flag('list-categories')) {
  console.log('\nAvailable categories:\n')
  for (const [key, val] of Object.entries(CATEGORIES)) {
    console.log(`  --category ${key.padEnd(28)} ${val.label} (~${val.pages} pages)`)
  }
  process.exit(0)
}

const catInfo = CATEGORIES[CATEGORY]
if (!catInfo) {
  console.error(`Unknown category: ${CATEGORY}. Use --list-categories to see options.`)
  process.exit(1)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

function slugToIdentifier(slug) {
  let id = decodeURIComponent(slug)
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!/^[A-Za-z0-9]/.test(id)) id = 'mod-' + id
  return id.slice(0, 128).toLowerCase()
}

/** Decode common HTML entities. */
function decodeEntities(str) {
  return str
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

// ─── HTML Parser ─────────────────────────────────────────────────────────────

/**
 * Parse resource entries from a BeamNG.com listing page's raw HTML.
 *
 * XenForo Resource Manager renders each resource as an <li id="resource-{id}">.
 * We split by that boundary and extract fields from each block.
 *
 * Actual HTML structure (relative URLs, multiline <a> tags):
 *   <h3 class="title">
 *     <span class="prefix ...">Beta</span>
 *     <a\n href="resources/{slug}.{id}/">Title</a>
 *     <span class="version">1.0</span>
 *   </h3>
 *   <div class="resourceDetails muted">
 *     <a href="resources/authors/{author}.{uid}/">AuthorName</a>, ...
 *   </div>
 *   <div class="tagLine">Description text</div>
 *   <dl class="resourceDownloads"><dt>Downloads:</dt> <dd>76,121</dd></dl>
 */
function parsePage(html) {
  const results = []
  const chunks = html.split(/id="resource-/)

  for (let i = 1; i < chunks.length; i++) {
    try {
      const idMatch = chunks[i].match(/^(\d+)/)
      if (!idMatch) continue
      const resourceId = idMatch[1]
      const block = chunks[i].slice(0, 6000)

      // Resource link (relative URL, possibly multiline <a> tag)
      // Pattern: href="resources/{slug}.{id}/"
      const linkRe = /href="resources\/([\w%.-]+?)\.(\d+)\/"/g
      let bestLink = null
      let m
      while ((m = linkRe.exec(block)) !== null) {
        if (m[2] === resourceId) { bestLink = m; break }
      }
      if (!bestLink) continue
      const slug = bestLink[1]

      // Title: text inside the <a> that links to this resource
      // The <a> tag can span multiple lines: <a\nhref="resources/...">Title</a>
      const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const titleRe = new RegExp(
        `href="resources/${escapedSlug}\\.${resourceId}/"[^>]*>([^<]+?)</a>`, 's'
      )
      const titleMatch = block.match(titleRe)
      const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : null
      if (!title) continue

      // Version
      const verMatch = block.match(/class="version"[^>]*>\s*([^<]+)\s*</)
      const version = verMatch ? verMatch[1].trim() : null

      // Author — from resources/authors/ link
      const authorMatch = block.match(/href="resources\/authors\/[^"]*"[^>]*>([^<]+)</)
                       || block.match(/class="username[^"]*"[^>]*>([^<]+)</)
      const author = authorMatch ? authorMatch[1].trim() : 'Unknown'

      // Status prefix (Beta / Alpha / Experimental)
      const prefixMatch = block.match(/class="prefix[^"]*"[^>]*>\s*([^<]+)\s*</)
      const prefix = prefixMatch ? prefixMatch[1].trim().toLowerCase() : null

      // Description — from tagLine div (direct text content)
      let abstract = title
      const tagLine = block.match(/class="tagLine"[^>]*>([\s\S]*?)<\/div>/)
      if (tagLine) {
        const text = decodeEntities(tagLine[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
        if (text.length >= 3) abstract = text
      }

      // Download count — <dl class="resourceDownloads"><dt>Downloads:</dt> <dd>76,121</dd></dl>
      const dlMatch = block.match(/Downloads:<\/dt>\s*<dd>([\d,]+)<\/dd>/)
      const downloads = dlMatch ? parseInt(dlMatch[1].replace(/,/g, ''), 10) : 0

      // Map prefix to release status
      let releaseStatus = 'stable'
      if (prefix === 'beta') releaseStatus = 'testing'
      else if (prefix === 'alpha' || prefix === 'experimental') releaseStatus = 'development'

      results.push({
        resourceId, slug, title, version, author,
        abstract: abstract.slice(0, 512), downloads, releaseStatus,
      })
    } catch { /* skip malformed entries */ }
  }
  return results
}

// ─── Template Builder ────────────────────────────────────────────────────────

function buildTemplate(mod) {
  return {
    spec_version: 1,
    identifier: slugToIdentifier(mod.slug),
    $kref: `#/beamng/${mod.resourceId}`,
    name: mod.title,
    abstract: mod.abstract,
    author: mod.author,
    license: 'restricted',
    kind: 'package',
    mod_type: catInfo.type,
    release_status: mod.releaseStatus,
    tags: [],
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== BeamNG-Mod-Registry Seeder ===`)
  console.log(`Category:       ${catInfo.label} (${CATEGORY})`)
  console.log(`Pages:          ${START_PAGE} - ${END_PAGE}`)
  console.log(`Min downloads:  ${MIN_DL.toLocaleString()}`)
  console.log(`Delay:          ${DELAY_MS}ms`)
  console.log(`Mode:           ${DRY_RUN ? 'DRY RUN' : 'WRITE'}\n`)

  if (!existsSync(NETBEAMMOD_DIR)) mkdirSync(NETBEAMMOD_DIR, { recursive: true })

  const existing = new Set(
    readdirSync(NETBEAMMOD_DIR)
      .filter(f => f.endsWith('.netbeammod'))
      .map(f => f.replace('.netbeammod', ''))
  )

  let total = 0, created = 0, skippedExist = 0, skippedDL = 0, pageErrors = 0

  for (let page = START_PAGE; page <= END_PAGE; page++) {
    const url = `https://www.beamng.com/resources/categories/${CATEGORY}/?page=${page}`
    process.stdout.write(`[${page}/${END_PAGE}] ${url} ... `)

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'BeamNG-Mod-Registry/1.0 (+https://github.com/musanajam11/BeamNG-Mod-Registry)',
          'Accept': 'text/html',
        },
        redirect: 'follow',
      })

      if (!res.ok) {
        console.log(`HTTP ${res.status} — skipped`)
        pageErrors++
        continue
      }

      const html = await res.text()
      const mods = parsePage(html)
      console.log(`${mods.length} resources`)

      for (const mod of mods) {
        total++
        const id = slugToIdentifier(mod.slug)

        if (existing.has(id)) { skippedExist++; continue }
        if (mod.downloads < MIN_DL) { skippedDL++; continue }

        const tmpl = buildTemplate(mod)
        const fp = join(NETBEAMMOD_DIR, `${id}.netbeammod`)

        if (DRY_RUN) {
          console.log(`    [dry] ${id} — ${mod.title} (${mod.downloads.toLocaleString()} DLs)`)
        } else {
          writeFileSync(fp, JSON.stringify(tmpl, null, 2) + '\n')
          console.log(`    + ${id} (${mod.downloads.toLocaleString()} DLs)`)
        }
        existing.add(id)
        created++
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`)
      pageErrors++
    }

    if (page < END_PAGE) await sleep(DELAY_MS)
  }

  console.log(`\n=== Summary ===`)
  console.log(`Resources found:     ${total}`)
  console.log(`Templates ${DRY_RUN ? 'would create' : 'created'}:  ${created}`)
  console.log(`Skipped (existing):  ${skippedExist}`)
  console.log(`Skipped (< ${MIN_DL.toLocaleString()} DLs): ${skippedDL}`)
  console.log(`Page errors:         ${pageErrors}`)
}

main().catch(err => { console.error(err); process.exit(1) })
