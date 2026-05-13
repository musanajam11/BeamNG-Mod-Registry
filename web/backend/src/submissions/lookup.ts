/**
 * Mod Lookup — alternative to uploading a zip. Given a public source URL
 * (GitHub repo or BeamNG.com resource), fetch as much rich metadata as
 * possible to pre-populate the submission form:
 *
 *   - identifier (slugified)
 *   - name, abstract, author, license, description
 *   - download URL + (optional) hash + size
 *   - version, release_status, release_date
 *   - mod_type guess (vehicle/map/skin/sound/scenario/ui_app)
 *   - tags
 *   - thumbnail
 *   - resources.{repository, beamng_resource, homepage, bugtracker}
 *   - kref (#/github/owner/repo or #/beamng/<id>)
 *   - multiplayer_scope guess (client/server/both) with confidence + reasons
 *
 * GitHub:    uses the public REST API (optionally Bearer token to raise
 *            rate limits) for repo + latest release + README + recursive
 *            tree (file paths) + a small sample of `.lua` files for
 *            BeamMP API sniffing.
 * BeamNG.com: scrapes the resource HTML page (XenForo Resource Manager) +
 *             a couple of secondary pages (overview/history) for richer
 *             fields than the inflator's bare "version + download" pull.
 *
 * BeamNG.com HTML parsing intentionally uses targeted regexes instead of a
 * full DOM library — XenForo's Resource Manager markup is stable enough,
 * and we avoid pulling jsdom (~30 MB transitively) into the backend.
 */
import {
  collectLuaSignals, collectPathSignals, collectTextSignals, collectTopicSignals,
  decideScope, type ScopeSignal,
} from './multiplayerScope.js'

const UA = 'BeamNG-Mod-Registry-Web/1.0 (mod-lookup)'
const FETCH_TIMEOUT_MS = 30_000

const GITHUB_HEADERS = (): Record<string, string> => ({
  'Accept': 'application/vnd.github+json',
  'User-Agent': UA,
  'X-GitHub-Api-Version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
})

export type LookupSource = 'github' | 'beamng'

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
  source: LookupSource
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
  /** Other releases available (lighter info), most recent first. */
  releases: LookupRelease[]
  /**
   * Best-guess BeamMP scope based on file layout, README text, GitHub
   * topics, and (when available) Lua source sniffing. Undefined when the
   * mod doesn't look multiplayer-related at all.
   */
  multiplayer_scope?: 'client' | 'server' | 'both'
  /** 0–100 confidence that the chosen `multiplayer_scope` is correct. */
  multiplayer_scope_confidence?: number
  /** Human-readable reasons (deduped) backing the scope decision. */
  multiplayer_scope_reasons?: string[]
  warnings: string[]
  /** Echoed back so the UI can show what we hit. */
  meta: Record<string, unknown>
}

// ─── URL parsing ─────────────────────────────────────────────────────────────

export function parseLookupUrl(raw: string):
  | { source: 'github'; owner: string; repo: string }
  | { source: 'beamng'; resourceId: string; slug: string | null }
  | null {
  const t = raw.trim()
  if (!t) return null
  // Accept bare krefs too.
  const krefGh = t.match(/^#\/github\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/)
  if (krefGh) return { source: 'github', owner: krefGh[1]!, repo: krefGh[2]! }
  const krefBn = t.match(/^#\/beamng\/(\d+)$/)
  if (krefBn) return { source: 'beamng', resourceId: krefBn[1]!, slug: null }

  let u: URL
  try {
    u = new URL(t)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (host === 'github.com' || host === 'www.github.com') {
    const m = u.pathname.match(/^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/.*)?$/)
    if (!m) return null
    return { source: 'github', owner: m[1]!, repo: m[2]! }
  }
  if (host === 'beamng.com' || host === 'www.beamng.com') {
    // /resources/<slug>.<id>/ or /resources/<id>/
    const m = u.pathname.match(/^\/resources\/(?:([^/]+?)\.)?(\d+)(?:\/.*)?$/)
    if (!m) return null
    return { source: 'beamng', resourceId: m[2]!, slug: m[1] ?? null }
  }
  return null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeoutFetch(url: string, init: RequestInit = {}, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' }).finally(() => clearTimeout(t))
}

/** Make a registry-friendly slug. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'mod'
}

/** v1.2.3 → 1.2.3 ; r12 → 12 ; otherwise unchanged. */
function cleanVersion(tag: string): string {
  let v = tag.trim()
  if (/^v\d/i.test(v)) v = v.slice(1)
  return v
}

function firstParagraph(text: string, max = 512): string {
  const t = text.replace(/\r/g, '').trim()
  if (!t) return ''
  // Strip MD headings/badges from the very top before picking the first paragraph.
  const lines = t.split('\n').filter((l) => !/^#/.test(l) && !/^\[!\[/.test(l) && !/^!\[/.test(l))
  const joined = lines.join('\n').trim()
  const para = joined.split(/\n\s*\n/)[0] ?? ''
  return para.replace(/\s+/g, ' ').trim().slice(0, max)
}

function htmlToText(html: string): string {
  // Cheap HTML → text: strip tags, decode a handful of entities.
  return html
    .replace(/<br\s*\/?>(?!<)/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

interface GhRepo {
  name: string
  full_name: string
  description: string | null
  html_url: string
  homepage: string | null
  topics?: string[]
  license: { spdx_id: string | null; name: string | null } | null
  owner: { login: string; avatar_url: string }
  has_issues: boolean
  default_branch: string
}

interface GhRelease {
  tag_name: string
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  published_at: string | null
  assets: { name: string; browser_download_url: string; size: number }[]
}

export async function lookupGithub(owner: string, repo: string): Promise<LookupResult> {
  const warnings: string[] = []
  const headers = GITHUB_HEADERS()

  // Repo metadata
  const repoRes = await timeoutFetch(`https://api.github.com/repos/${owner}/${repo}`, { headers })
  if (!repoRes.ok) {
    throw new Error(`GitHub repo ${owner}/${repo} → HTTP ${repoRes.status}`)
  }
  const r = (await repoRes.json()) as GhRepo

  // Releases (latest first). Use list endpoint so we can show alternates and
  // gracefully handle repos where /latest 404s (no full releases).
  let releases: GhRelease[] = []
  try {
    const relRes = await timeoutFetch(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`,
      { headers },
    )
    if (relRes.ok) releases = (await relRes.json()) as GhRelease[]
    else warnings.push(`releases endpoint HTTP ${relRes.status}`)
  } catch (err) {
    warnings.push(`releases fetch failed: ${(err as Error).message}`)
  }
  const usable = releases.filter((x) => !x.draft)
  const latest = usable[0] ?? null

  // README → first paragraph as abstract, full text as description.
  let readmeMd: string | null = null
  try {
    const readmeRes = await timeoutFetch(
      `https://api.github.com/repos/${owner}/${repo}/readme`,
      { headers: { ...headers, Accept: 'application/vnd.github.raw' } },
    )
    if (readmeRes.ok) readmeMd = await readmeRes.text()
  } catch {
    /* optional */
  }

  const pickRelease = (rel: GhRelease | null): LookupRelease | null => {
    if (!rel) return null
    // Prefer first .zip asset; fall back to first asset; else the source
    // tarball auto-generated by GitHub.
    const asset =
      rel.assets.find((a) => /\.zip$/i.test(a.name)) ||
      rel.assets[0] ||
      null
    const downloadUrl =
      asset?.browser_download_url ??
      `https://github.com/${owner}/${repo}/archive/refs/tags/${encodeURIComponent(rel.tag_name)}.zip`
    return {
      tag: rel.tag_name,
      version: cleanVersion(rel.tag_name),
      download_url: downloadUrl,
      download_size: asset?.size ?? null,
      asset_name: asset?.name ?? null,
      published_at: rel.published_at,
      prerelease: rel.prerelease,
      notes_markdown: rel.body ?? null,
    }
  }

  const release = pickRelease(latest)
  const altReleases = usable.slice(0, 10).map(pickRelease).filter((x): x is LookupRelease => x !== null)

  // ── Multiplayer-scope detection ───────────────────────────────────────
  // Pull the recursive tree once, sniff path patterns + a small sample of
  // Lua files for BeamMP server/client API calls, then combine with topic
  // and README signals.
  const scopeSignals: ScopeSignal[] = []
  let treePaths: string[] = []
  let treeTruncated = false
  try {
    const treeRes = await timeoutFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(r.default_branch)}?recursive=1`,
      { headers },
    )
    if (treeRes.ok) {
      const tree = (await treeRes.json()) as {
        truncated?: boolean
        tree?: { path: string; type: string; size?: number; sha: string }[]
      }
      treeTruncated = tree.truncated === true
      treePaths = (tree.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path)
      scopeSignals.push(...collectPathSignals(treePaths))

      // Pick up to a handful of small Lua files \u2014 prefer ones inside
      // Resources/{Server,Client}/ since they're the most diagnostic.
      const luaCandidates = (tree.tree ?? [])
        .filter((t) =>
          t.type === 'blob' &&
          /\.lua$/i.test(t.path) &&
          (t.size ?? 0) > 0 &&
          (t.size ?? 0) <= 64 * 1024,
        )
        .sort((a, b) => {
          const score = (n: string) => /resources\/(server|client)\//i.test(n) ? 0 : 1
          return score(a.path) - score(b.path) || (a.size ?? 0) - (b.size ?? 0)
        })
        .slice(0, 6)
      let totalBytes = 0
      const luaParts: string[] = []
      for (const blob of luaCandidates) {
        if (totalBytes >= 192 * 1024) break
        try {
          const blobRes = await timeoutFetch(
            `https://api.github.com/repos/${owner}/${repo}/git/blobs/${blob.sha}`,
            { headers },
          )
          if (!blobRes.ok) continue
          const data = (await blobRes.json()) as { content?: string; encoding?: string }
          if (data.encoding === 'base64' && typeof data.content === 'string') {
            const text = Buffer.from(data.content, 'base64').toString('utf-8')
            luaParts.push(text)
            totalBytes += text.length
          }
        } catch {
          /* skip */
        }
      }
      if (luaParts.length > 0) {
        scopeSignals.push(...collectLuaSignals(luaParts.join('\n')))
      }
    } else {
      warnings.push(`tree endpoint HTTP ${treeRes.status}`)
    }
  } catch (err) {
    warnings.push(`tree fetch failed: ${(err as Error).message}`)
  }

  // Topic-based hints (e.g. `beammp-plugin`, `beammp-server`, `beammp-mod`).
  scopeSignals.push(...collectTopicSignals(r.topics ?? []))

  // README phrasing \u2014 install paths, "server-side", "client mod auto-fetched".
  if (readmeMd) scopeSignals.push(...collectTextSignals(readmeMd))
  if (r.description) scopeSignals.push(...collectTextSignals(r.description))

  const scope = decideScope(scopeSignals)

  // Identifier: prefer repo name if it already looks like a slug, else slugify.
  const identifier = slugify(r.name || `${owner}-${repo}`)

  const description = readmeMd ?? r.description ?? ''
  const abstractText =
    (r.description && r.description.trim()) ||
    (readmeMd ? firstParagraph(readmeMd, 256) : '')

  const result: LookupResult = {
    source: 'github',
    source_url: r.html_url,
    kref: `#/github/${owner}/${repo}`,
    identifier,
    name: r.name,
    abstract: abstractText || undefined,
    author: r.owner.login,
    license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : undefined,
    description: description || undefined,
    tags: Array.from(new Set((r.topics ?? []).map((t) => t.toLowerCase()))).slice(0, 16),
    thumbnail: r.owner.avatar_url, // best non-zip guess; user can override
    resources: {
      repository: r.html_url,
      homepage: r.homepage || undefined,
      bugtracker: r.has_issues ? `${r.html_url}/issues` : undefined,
    },
    release,
    releases: altReleases,
    multiplayer_scope: scope.scope,
    multiplayer_scope_confidence: scope.is_multiplayer ? scope.confidence : undefined,
    multiplayer_scope_reasons: scope.is_multiplayer
      ? Array.from(new Set(scope.signals.map((s) => s.reason)))
      : undefined,
    warnings,
    meta: {
      default_branch: r.default_branch,
      releases_total: releases.length,
      readme_chars: readmeMd?.length ?? 0,
      tree_files: treePaths.length,
      tree_truncated: treeTruncated,
    },
  }
  // Heuristic mod_type from topics
  const topics = result.tags
  if (topics.includes('vehicle') || topics.includes('car')) result.mod_type = 'vehicle'
  else if (topics.includes('map') || topics.includes('level')) result.mod_type = 'map'
  else if (topics.includes('skin') || topics.includes('livery')) result.mod_type = 'skin'
  else if (topics.includes('sound') || topics.includes('siren')) result.mod_type = 'sound'
  else if (topics.includes('scenario')) result.mod_type = 'scenario'
  return result
}

// ─── BeamNG.com (XenForo Resource Manager) ───────────────────────────────────

const BEAMNG_CATEGORY_TO_MODTYPE: Record<string, string> = {
  vehicles: 'vehicle',
  cars: 'vehicle',
  trucks: 'vehicle',
  buses: 'vehicle',
  trailers: 'vehicle',
  aircraft: 'vehicle',
  boats: 'vehicle',
  trains: 'vehicle',
  'land-vehicles': 'vehicle',
  terrains: 'map',
  'levels-and-terrains': 'map',
  maps: 'map',
  scenarios: 'scenario',
  configurations: 'skin',
  skins: 'skin',
  sounds: 'sound',
  'ui-apps': 'ui_app',
  apps: 'ui_app',
  mods: 'other',
  'license-plates': 'license_plate',
  automation: 'automation',
}

function textOf(html: string): string {
  return htmlToText(html).replace(/\s+/g, ' ').trim()
}

function absoluteUrl(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined
  try {
    return new URL(href, base).toString()
  } catch {
    return undefined
  }
}

/** First captured group of the first matching regex, trimmed; null if none. */
function firstMatch(html: string, ...patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m[1]) return m[1].trim()
  }
  return null
}

/** Decode HTML entities for short strings (titles, taglines). */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
}

export async function lookupBeamng(resourceId: string): Promise<LookupResult> {
  const warnings: string[] = []
  const base = `https://www.beamng.com/resources/${resourceId}/`
  const headers = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }

  const res = await timeoutFetch(base, { headers })
  if (!res.ok) {
    throw new Error(`BeamNG.com resource ${resourceId} → HTTP ${res.status}`)
  }
  const html = await res.text()
  const finalUrl = res.url || base

  // ── Title (XF2: <h1 class="p-title-value">…</h1> with optional version span) ─
  const titleHtml =
    firstMatch(html, /<h1[^>]*class="[^"]*p-title-value[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
    firstMatch(html, /<h1[^>]*class="[^"]*resourceTitle[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
    ''
  let title = decodeEntities(textOf(titleHtml))
  // Strip a trailing version chunk that XF often includes inside the title.
  let version: string | null = null
  const verSuffix = title.match(/\s+(\d+(?:\.\d+)+(?:[A-Za-z0-9._-]*)?)\s*$/)
  if (verSuffix) {
    version = verSuffix[1]!
    title = title.slice(0, verSuffix.index).trim()
  }

  // ── OpenGraph fallbacks ─────────────────────────────────────────────────
  const ogTitle = firstMatch(html, /<meta\s+property="og:title"\s+content="([^"]+)"/i)
  const ogDesc = firstMatch(
    html,
    /<meta\s+property="og:description"\s+content="([^"]+)"/i,
    /<meta\s+name="description"\s+content="([^"]+)"/i,
  )
  const ogImage = firstMatch(html, /<meta\s+property="og:image"\s+content="([^"]+)"/i)
  if (!title && ogTitle) title = decodeEntities(ogTitle).replace(/\s*\|.*$/, '').trim()

  // ── Tagline / subtitle ──────────────────────────────────────────────────
  const taglineHtml =
    firstMatch(html, /<div[^>]*class="[^"]*p-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
    firstMatch(html, /<p[^>]*class="[^"]*tagLine[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
    ''
  const tagline = decodeEntities(textOf(taglineHtml))

  // ── Author (first <a class="username"> on the page) ─────────────────────
  let author = decodeEntities(
    firstMatch(html, /<a[^>]*class="[^"]*username[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ?? '',
  )
  author = textOf(author)

  // ── Version fallbacks ───────────────────────────────────────────────────
  if (!version) {
    version =
      firstMatch(
        html,
        /Version:\s*<\/(?:dt|span|strong)>\s*<(?:dd|span|div)[^>]*>([^<]+)</i,
        /Version:\s*([0-9][A-Za-z0-9._-]*)/,
        /"version"\s*:\s*"([^"]+)"/i,
      ) ?? null
    if (version) version = version.trim()
  }

  // ── Sidebar definition list (first release / last update / downloads) ──
  // Walk all <dl>…</dl> blocks and pair their <dt>/<dd> children.
  const dlMap: Record<string, string> = {}
  for (const dlMatch of html.matchAll(/<dl[\s\S]*?<\/dl>/gi)) {
    const dl = dlMatch[0]
    const dts = [...dl.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/gi)].map((m) => textOf(m[1]!))
    const dds = [...dl.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/gi)].map((m) => textOf(m[1]!))
    for (let i = 0; i < dts.length && i < dds.length; i++) {
      const k = dts[i]!.toLowerCase().replace(/:$/, '').trim()
      const v = dds[i]!.trim()
      if (k && v && !(k in dlMap)) dlMap[k] = v
    }
  }

  // ── Category from breadcrumbs ───────────────────────────────────────────
  const breadcrumbItems: string[] = []
  for (const m of html.matchAll(
    /<(?:li|a)[^>]*class="[^"]*(?:p-breadcrumbs__item|crumb|breadcrumb)[^"]*"[^>]*>([\s\S]*?)<\/(?:li|a)>/gi,
  )) {
    const t = decodeEntities(textOf(m[1]!))
    if (t) breadcrumbItems.push(t)
  }
  const category = breadcrumbItems[breadcrumbItems.length - 1] ?? ''
  const categorySlug = category.toLowerCase().replace(/\s+/g, '-')
  const modType = BEAMNG_CATEGORY_TO_MODTYPE[categorySlug]

  // ── Tags ────────────────────────────────────────────────────────────────
  const tagSet = new Set<string>()
  for (const m of html.matchAll(/<a[^>]*href="[^"]*\/tags\/[^"]+"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = decodeEntities(textOf(m[1]!)).toLowerCase()
    if (t) tagSet.add(t)
  }
  const tags = Array.from(tagSet).slice(0, 16)

  // ── Description body (XF2: <article class="message-body"> .bbWrapper) ──
  const descHtml =
    firstMatch(
      html,
      /<article[^>]*class="[^"]*message-body[^"]*"[\s\S]*?<div[^>]*class="[^"]*bbWrapper[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/article>/i,
    ) ||
    firstMatch(html, /<div[^>]*class="[^"]*bbWrapper[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
    ''
  let description = htmlToText(decodeEntities(descHtml))
  if (!description && ogDesc) description = htmlToText(decodeEntities(ogDesc))

  // ── Thumbnail ───────────────────────────────────────────────────────────
  const thumbnail =
    (ogImage && absoluteUrl(decodeEntities(ogImage), finalUrl)) ||
    absoluteUrl(
      firstMatch(
        html,
        /<img[^>]*class="[^"]*resourceIcon[^"]*"[^>]*src="([^"]+)"/i,
        /<div[^>]*class="[^"]*resourceImage[^"]*"[\s\S]*?<img[^>]*src="([^"]+)"/i,
      ),
      finalUrl,
    )

  // License is rarely structured; default closed-source for BeamNG community
  // mods unless the description mentions a permissive license.
  const license = /\b(open[-\s]?source|MIT|GPL[v\d]*|Apache|BSD|MPL)\b/i.test(description)
    ? undefined
    : 'restricted'

  // Identifier from URL slug if available, else from title.
  const slugMatch = finalUrl.match(/\/resources\/([^/.]+)\.\d+/)
  const identifier = slugify(slugMatch?.[1] || title || `beamng-${resourceId}`)

  const abstractText = (tagline || description.split(/(?<=[.!?])\s+/)[0] || '').slice(0, 512)

  if (!version) warnings.push('could not determine current version from page')

  const release: LookupRelease | null = version
    ? {
        tag: version,
        version,
        download_url: `https://www.beamng.com/resources/${resourceId}/download`,
        download_size: null,
        asset_name: null,
        published_at: dlMap['last update'] || dlMap['updated'] || null,
        prerelease: false,
        notes_markdown: null,
      }
    : null

  // Multiplayer scope from description text + tags. BeamNG.com pages don't
  // expose a file tree, so this is text-only.
  const scopeSignals: ScopeSignal[] = []
  if (description) scopeSignals.push(...collectTextSignals(description))
  if (tagline) scopeSignals.push(...collectTextSignals(tagline))
  // Treat the resource's tag list like topics so e.g. a "BeamMP" tag pairs
  // with phrasing-derived signals to push the decision over the threshold.
  scopeSignals.push(...collectTopicSignals(tags))
  const scope = decideScope(scopeSignals)

  return {
    source: 'beamng',
    source_url: finalUrl,
    kref: `#/beamng/${resourceId}`,
    identifier,
    name: title || undefined,
    abstract: abstractText || undefined,
    author: author || undefined,
    license,
    description: description || undefined,
    mod_type: modType,
    tags,
    thumbnail,
    resources: {
      beamng_resource: finalUrl,
    },
    release,
    releases: release ? [release] : [],
    multiplayer_scope: scope.scope,
    multiplayer_scope_confidence: scope.is_multiplayer ? scope.confidence : undefined,
    multiplayer_scope_reasons: scope.is_multiplayer
      ? Array.from(new Set(scope.signals.map((s) => s.reason)))
      : undefined,
    warnings,
    meta: {
      category,
      first_release: dlMap['first release'] || dlMap['first released'],
      last_update: dlMap['last update'] || dlMap['updated'],
      downloads: dlMap['downloads'] || dlMap['total downloads'],
      rating: dlMap['rating'],
    },
  }
}

// ─── Top-level dispatcher ────────────────────────────────────────────────────

export async function lookup(url: string): Promise<LookupResult> {
  const parsed = parseLookupUrl(url)
  if (!parsed) {
    throw new Error('Unsupported URL — paste a github.com repo or a beamng.com/resources/… link')
  }
  if (parsed.source === 'github') return lookupGithub(parsed.owner, parsed.repo)
  return lookupBeamng(parsed.resourceId)
}
