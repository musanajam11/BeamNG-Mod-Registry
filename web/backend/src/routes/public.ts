/**
 * Public read-only routes for browsing the local registry on disk. Used by
 * the in-app Registry Browser. Requires authentication so it isn't a
 * scraping endpoint, but does not require admin.
 */
import type { FastifyInstance } from 'fastify'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { requireAuth } from '../auth/plugin.js'
import { config } from '../config.js'
import { db } from '../db.js'
import { getRegistry, summarize, type ModEntry } from '../registry/index.js'
import { getTheme } from '../settings.js'
import { getOwnerInfo, loadOwners } from '../submissions/ownership.js'
import { clearRating, EMPTY_RATING, getRating, loadRatings, setRating } from '../submissions/ratings.js'

/**
 * Lightweight per-mod edit attribution: the most recent merged submission
 * (manual_beammod / new_version / netbeammod_*) per identifier, joined with
 * the submitting user. Used to show "last edited by" on listing cards and
 * detail views without requiring a separate request per card.
 */
interface LastEditRow {
  identifier: string
  user_id: number
  display_name: string
  avatar_url: string | null
  kind: string
  version: string | null
  decided_at: number | null
}

// Treat both `pr_opened` (PR awaiting/landed on GitHub) and `merged`
// as "contribution accepted" for attribution purposes. We don't currently
// poll GitHub to flip pr_opened -> merged, so restricting to 'merged'
// would hide every edit a contributor has actually made.
const CONTRIBUTION_STATUSES = "('pr_opened','merged')"

function loadLastEdits(): Map<string, LastEditRow> {
  const rows = db
    .prepare(
      `SELECT s.identifier, s.user_id, s.kind, s.version, s.decided_at,
              u.display_name, u.avatar_url
         FROM submissions s
         JOIN users u ON u.id = s.user_id
        WHERE s.status IN ${CONTRIBUTION_STATUSES}
        ORDER BY COALESCE(s.decided_at, s.created_at) DESC`
    )
    .all() as LastEditRow[]
  const out = new Map<string, LastEditRow>()
  for (const r of rows) if (!out.has(r.identifier)) out.set(r.identifier, r)
  return out
}

function loadHistory(identifier: string): LastEditRow[] {
  return db
    .prepare(
      `SELECT s.identifier, s.user_id, s.kind, s.version, s.decided_at,
              u.display_name, u.avatar_url
         FROM submissions s
         JOIN users u ON u.id = s.user_id
        WHERE s.status IN ${CONTRIBUTION_STATUSES} AND s.identifier = ?
        ORDER BY COALESCE(s.decided_at, s.created_at) DESC
        LIMIT 50`
    )
    .all(identifier) as LastEditRow[]
}

const QuerySchema = z.object({
  q: z.string().trim().max(128).optional(),
  type: z.string().trim().max(32).optional(),
  tag: z.string().trim().max(64).optional(),
  // ── Extended filters ──────────────────────────────────────────────────
  // Comma-separated for multi-value fields. All filters AND together; for
  // `tags` the `tag_mode=any` switch flips to OR semantics.
  tags: z.string().trim().max(512).optional(),
  tag_mode: z.enum(['all', 'any']).optional(),
  author: z.string().trim().max(128).optional(),
  license: z.string().trim().max(64).optional(),
  kind: z.string().trim().max(32).optional(),
  status: z.string().trim().max(32).optional(),
  multiplayer: z.string().trim().max(16).optional(),
  verified: z.enum(['true', 'false']).optional(),
  /** Comma list: download,thumbnail,repository,homepage,bugtracker,beamng_resource,depends,provides */
  has: z.string().trim().max(256).optional(),
  min_rating: z.coerce.number().min(0).max(5).optional(),
  /** Sort order. Default: verified-first, then name. */
  sort: z
    .enum(['name', '-name', 'identifier', '-identifier', 'rating', '-rating', 'recent'])
    .optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
})

function csv(s: string | undefined): string[] {
  if (!s) return []
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

const RESOURCE_FIELDS = new Set(['repository', 'homepage', 'bugtracker', 'beamng_resource', 'beammp_forum'])
const RAW_PRESENCE_FIELDS = new Set(['depends', 'recommends', 'suggests', 'supports', 'conflicts', 'provides', 'install', 'description'])

/** True if the mod entry has a non-empty value for the given `has:` field. */
function hasField(m: ReturnType<typeof summarize> & { raw?: Record<string, unknown> }, field: string): boolean {
  if (field === 'download') return Boolean(m.download)
  if (field === 'thumbnail') return Boolean(m.thumbnail)
  if (RESOURCE_FIELDS.has(field)) {
    const v = (m.resources as Record<string, unknown> | undefined)?.[field]
    return typeof v === 'string' && v.length > 0
  }
  if (RAW_PRESENCE_FIELDS.has(field)) {
    // `summarize` doesn't include `raw` so we look it up off the original
    // entry from getRegistry() — callers pass it in.
    const v = (m as unknown as { raw?: Record<string, unknown> }).raw?.[field]
    if (Array.isArray(v)) return v.length > 0
    if (typeof v === 'string') return v.length > 0
    return Boolean(v)
  }
  return false
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true }))

  // Public theme so unauthenticated pages (login/signup) can apply admin
  // customizations before the user has a session.
  app.get('/theme', async () => getTheme())

  // ─── News feed (BeamNG Steam RSS + BeamMP GitHub releases) ──────────────
  // Mirrors the widget used by BeamMP Content Manager. Cached for 30 min so
  // we don't hammer Steam / GitHub on every dashboard load. Public so the
  // login screen could surface it later if desired.
  type NewsItem = {
    id: string
    source: 'steam' | 'beammp'
    title: string
    url: string
    date: number
    summary: string
  }
  const NEWS_TTL_MS = 30 * 60 * 1000
  let newsCache: { items: NewsItem[]; fetchedAt: number } | null = null

  async function fetchNewsFeed(): Promise<NewsItem[]> {
    const items: NewsItem[] = []
    let steamOk = false
    let ghOk = false

    try {
      const res = await fetch('https://store.steampowered.com/feeds/news/app/284160')
      if (res.ok) {
        const xml = await res.text()
        const itemRe = /<item>([\s\S]*?)<\/item>/g
        let m: RegExpExecArray | null
        let count = 0
        while ((m = itemRe.exec(xml)) !== null && count < 4) {
          const block = m[1] ?? ''
          const title = block.match(/<title>(.*?)<\/title>/)?.[1] ?? ''
          const link =
            block.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/)?.[1] ??
            block.match(/<link>(.*?)<\/link>/)?.[1] ?? ''
          const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? ''
          const desc = block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ''
          let cleaned = desc.replace(/<!\[CDATA\[|\]\]>/g, '')
          let prev = cleaned
          do { prev = cleaned; cleaned = cleaned.replace(/<[^>]+>/g, '') } while (cleaned !== prev)
          const summary = cleaned
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&')
            .trim().slice(0, 240)
          if (title) {
            items.push({
              id: `steam-${count}`,
              source: 'steam',
              title,
              url: link,
              date: pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : 0,
              summary,
            })
            count++
          }
        }
        steamOk = true
      }
    } catch { /* network error, skip */ }

    try {
      const res = await fetch(
        'https://api.github.com/repos/BeamMP/BeamMP-Launcher/releases?per_page=4',
        { headers: { 'User-Agent': 'BeamNG-Mod-Registry', Accept: 'application/vnd.github+json' } },
      )
      if (res.ok) {
        const releases = (await res.json()) as Array<{
          id: number; name: string | null; tag_name: string
          html_url: string; published_at: string; body: string | null
        }>
        for (const rel of releases) {
          items.push({
            id: `gh-${rel.id}`,
            source: 'beammp',
            title: rel.name?.trim() || rel.tag_name || 'BeamMP Release',
            url: rel.html_url,
            date: Math.floor(new Date(rel.published_at).getTime() / 1000),
            summary: (rel.body ?? '').slice(0, 240).replace(/[#*_\r]/g, '').trim(),
          })
        }
        ghOk = true
      }
    } catch { /* network error, skip */ }

    items.sort((a, b) => b.date - a.date)
    if (steamOk && ghOk) newsCache = { items, fetchedAt: Date.now() }
    return items
  }

  app.get('/news', async () => {
    if (newsCache && Date.now() - newsCache.fetchedAt < NEWS_TTL_MS) {
      return { items: newsCache.items, cached: true }
    }
    const items = await fetchNewsFeed()
    return { items, cached: false }
  })

  // ─── BeamNG Content Manager latest release proxy ────────────────────────
  // The dashboard "Content Manager" page surfaces download links per OS.
  // Cached 30 min so we don't hit the GitHub API on every page load.
  type CMRelease = {
    version: string
    html_url: string
    published_at: string
    assets: {
      windows?: { name: string; size: number; url: string }
      linux_appimage?: { name: string; size: number; url: string }
      linux_deb?: { name: string; size: number; url: string }
      macos?: { name: string; size: number; url: string }
    }
  }
  const CM_TTL_MS = 30 * 60 * 1000
  let cmCache: { release: CMRelease; fetchedAt: number } | null = null

  app.get('/content-manager/latest', async (_req, reply) => {
    if (cmCache && Date.now() - cmCache.fetchedAt < CM_TTL_MS) {
      return { release: cmCache.release, cached: true }
    }
    try {
      const res = await fetch(
        'https://api.github.com/repos/musanajam11/BeamNG-Content-Manager/releases/latest',
        { headers: { 'User-Agent': 'BeamNG-Mod-Registry', Accept: 'application/vnd.github+json' } },
      )
      if (!res.ok) return reply.code(502).send({ error: 'github_unavailable' })
      const data = (await res.json()) as {
        tag_name: string; html_url: string; published_at: string
        assets: Array<{ name: string; size: number; browser_download_url: string }>
      }
      const release: CMRelease = {
        version: data.tag_name,
        html_url: data.html_url,
        published_at: data.published_at,
        assets: {},
      }
      for (const a of data.assets) {
        const entry = { name: a.name, size: a.size, url: a.browser_download_url }
        const lower = a.name.toLowerCase()
        if (lower.endsWith('-setup.exe')) release.assets.windows = entry
        else if (lower.endsWith('.appimage')) release.assets.linux_appimage = entry
        else if (lower.endsWith('.deb')) release.assets.linux_deb = entry
        else if (lower.endsWith('.dmg')) release.assets.macos = entry
      }
      cmCache = { release, fetchedAt: Date.now() }
      return { release, cached: false }
    } catch {
      return reply.code(502).send({ error: 'fetch_failed' })
    }
  })

  app.get('/mods', async (request, reply) => {
    // Public read: blocked-tier (red) accounts are still rejected, but a
    // signed-out viewer gets the same data minus their own per-mod rating.
    if (request.ctx?.user.trust === 'red') {
      return reply.code(403).send({ error: 'account_blocked' })
    }
    const viewerId = request.ctx?.user.id ?? null
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues })
    }
    const {
      q, type, tag, tags, tag_mode, author, license, kind, status,
      multiplayer, verified, has, min_rating, sort,
    } = parsed.data
    const page = parsed.data.page ?? 1
    const pageSize = parsed.data.pageSize ?? 24

    const { entries } = await getRegistry()
    let filtered = entries

    // Free-text needle searches name + identifier + author + abstract + tags.
    if (q) {
      const needle = q.toLowerCase()
      filtered = filtered.filter(
        (m) =>
          m.identifier.toLowerCase().includes(needle) ||
          m.name.toLowerCase().includes(needle) ||
          (m.author?.toLowerCase().includes(needle) ?? false) ||
          (m.abstract?.toLowerCase().includes(needle) ?? false) ||
          m.tags.some((t) => t.toLowerCase().includes(needle))
      )
    }

    if (type) filtered = filtered.filter((m) => m.mod_type === type)
    if (tag) filtered = filtered.filter((m) => m.tags.includes(tag))

    // Multi-tag filter (AND by default; OR with tag_mode=any).
    const tagList = csv(tags).map((t) => t.toLowerCase())
    if (tagList.length > 0) {
      const mode = tag_mode ?? 'all'
      filtered = filtered.filter((m) => {
        const owned = m.tags.map((t) => t.toLowerCase())
        return mode === 'any'
          ? tagList.some((t) => owned.includes(t))
          : tagList.every((t) => owned.includes(t))
      })
    }

    if (author) {
      const needle = author.toLowerCase()
      filtered = filtered.filter((m) => (m.author?.toLowerCase().includes(needle)) ?? false)
    }
    if (license) {
      const needle = license.toLowerCase()
      filtered = filtered.filter((m) => (m.license?.toLowerCase().includes(needle)) ?? false)
    }
    if (kind) filtered = filtered.filter((m) => m.kind === kind)
    if (status) filtered = filtered.filter((m) => m.release_status === status)
    if (multiplayer) filtered = filtered.filter((m) => m.multiplayer_scope === multiplayer)
    if (verified === 'true') filtered = filtered.filter((m) => m.verified)
    else if (verified === 'false') filtered = filtered.filter((m) => !m.verified)

    const hasFields = csv(has)
    if (hasFields.length > 0) {
      filtered = filtered.filter((m) => hasFields.every((f) => hasField(m, f)))
    }

    // Ratings: load once for the full set so we can both filter by minimum
    // rating and sort the entire result set before paginating.
    const ratings = loadRatings(viewerId)
    if (typeof min_rating === 'number' && min_rating > 0) {
      filtered = filtered.filter((m) => (ratings.get(m.identifier)?.avg ?? 0) >= min_rating)
    }

    // Sort. Default mirrors getRegistry()'s order (verified-first, name).
    if (sort) {
      const cmpName = (a: ModEntry, b: ModEntry) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      const cmpId = (a: ModEntry, b: ModEntry) =>
        a.identifier.localeCompare(b.identifier, undefined, { sensitivity: 'base' })
      const cmpRating = (a: ModEntry, b: ModEntry) => {
        const ra = ratings.get(a.identifier)?.avg ?? 0
        const rb = ratings.get(b.identifier)?.avg ?? 0
        if (ra !== rb) return ra - rb
        const ca = ratings.get(a.identifier)?.count ?? 0
        const cb = ratings.get(b.identifier)?.count ?? 0
        return ca - cb
      }
      filtered = [...filtered].sort((a, b) => {
        switch (sort) {
          case 'name': return cmpName(a, b)
          case '-name': return -cmpName(a, b)
          case 'identifier': return cmpId(a, b)
          case '-identifier': return -cmpId(a, b)
          case 'rating': return cmpRating(a, b)
          case '-rating': return -cmpRating(a, b)
          case 'recent': {
            // Best-effort recency: latest version string compare.
            return b.version.localeCompare(a.version, undefined, { numeric: true })
          }
        }
      })
    }

    const total = filtered.length
    const start = (page - 1) * pageSize
    const slice = filtered.slice(start, start + pageSize)

    // ── Facets (computed off the unfiltered set so users can see what
    // ── else is available across the registry). Cheap because everything
    // ── lives in memory.
    const typeCounts: Record<string, number> = {}
    const tagCounts: Record<string, number> = {}
    const kindCounts: Record<string, number> = {}
    const licenseCounts: Record<string, number> = {}
    const statusCounts: Record<string, number> = {}
    const multiplayerCounts: Record<string, number> = {}
    const authorCounts: Record<string, number> = {}
    let verifiedCount = 0
    for (const m of entries) {
      if (m.mod_type) typeCounts[m.mod_type] = (typeCounts[m.mod_type] ?? 0) + 1
      kindCounts[m.kind] = (kindCounts[m.kind] ?? 0) + 1
      if (m.license) licenseCounts[m.license] = (licenseCounts[m.license] ?? 0) + 1
      if (m.release_status) statusCounts[m.release_status] = (statusCounts[m.release_status] ?? 0) + 1
      if (m.multiplayer_scope) multiplayerCounts[m.multiplayer_scope] = (multiplayerCounts[m.multiplayer_scope] ?? 0) + 1
      if (m.author) authorCounts[m.author] = (authorCounts[m.author] ?? 0) + 1
      if (m.verified) verifiedCount++
      for (const t of m.tags) {
        if (!t) continue
        tagCounts[t] = (tagCounts[t] ?? 0) + 1
      }
    }
    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 200)
      .map(([value, count]) => ({ value, count }))
    const topAuthors = Object.entries(authorCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 100)
      .map(([value, count]) => ({ value, count }))

    const lastEdits = loadLastEdits()
    const owners = loadOwners()

    return {
      items: slice.map((m) => ({
        ...summarize(m),
        last_edit: lastEdits.get(m.identifier) ?? null,
        owner: owners.get(m.identifier) ?? null,
        rating: ratings.get(m.identifier) ?? EMPTY_RATING,
      })),
      total,
      page,
      pageSize,
      facets: {
        mod_types: typeCounts,
        kinds: kindCounts,
        licenses: licenseCounts,
        statuses: statusCounts,
        multiplayer: multiplayerCounts,
        verified: { true: verifiedCount, false: entries.length - verifiedCount },
        tags: topTags,
        authors: topAuthors,
      },
    }
  })

  // Edit history for one mod — every accepted submission, newest first.
  // Used by the registry browser drawer to show who has touched the entry.
  app.get('/mods/:identifier/history', async (request, reply) => {
    if (request.ctx?.user.trust === 'red') {
      return reply.code(403).send({ error: 'account_blocked' })
    }
    const { identifier } = request.params as { identifier: string }
    const { byId } = await getRegistry()
    if (!byId.has(identifier)) return reply.code(404).send({ error: 'not_found' })
    return { history: loadHistory(identifier) }
  })

  app.get('/mods/:identifier', async (request, reply) => {
    if (request.ctx?.user.trust === 'red') {
      return reply.code(403).send({ error: 'account_blocked' })
    }
    const viewerId = request.ctx?.user.id ?? null
    const { identifier } = request.params as { identifier: string }
    const { byId } = await getRegistry()
    const found = byId.get(identifier)
    if (!found) return reply.code(404).send({ error: 'not_found' })

    // Best-effort: surface the netbeammod template (if any) so the submit
    // form can pre-check the "watch upstream releases" box and prefill the
    // source URL when an author proposes an edit.
    let watch: { kref?: string; filter_asset?: string } | undefined
    try {
      const tmplPath = join(config.repoWorkdir, 'netbeammod', `${identifier}.netbeammod`)
      const text = await fs.readFile(tmplPath, 'utf-8')
      const tmpl = JSON.parse(text) as Record<string, unknown>
      const kref = typeof tmpl.$kref === 'string' ? tmpl.$kref : undefined
      const filterAsset = typeof tmpl.$filter_asset === 'string' ? tmpl.$filter_asset : undefined
      if (kref || filterAsset) watch = { kref, filter_asset: filterAsset }
    } catch {
      /* no template — that's fine */
    }

    const lastEdits = loadLastEdits()
    return {
      mod: found,
      watch,
      last_edit: lastEdits.get(identifier) ?? null,
      owner: getOwnerInfo(identifier),
      rating: getRating(identifier, viewerId),
    }
  })

  // ─── Per-mod ratings ─────────────────────────────────────────────────────
  // Authenticated users can leave one 1–5 star rating per mod identifier.
  // PUT replaces (idempotent), DELETE clears. Both return the updated
  // aggregate so the client can patch caches without a refetch.
  const RatingBodySchema = z.object({ stars: z.number().int().min(1).max(5) })

  app.put('/mods/:identifier/rating', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const { identifier } = request.params as { identifier: string }
    const { byId } = await getRegistry()
    if (!byId.has(identifier)) return reply.code(404).send({ error: 'not_found' })
    const parsed = RatingBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues })
    }
    setRating(identifier, ctx.user.id, parsed.data.stars)
    return { rating: getRating(identifier, ctx.user.id) }
  })

  app.delete('/mods/:identifier/rating', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const { identifier } = request.params as { identifier: string }
    const { byId } = await getRegistry()
    if (!byId.has(identifier)) return reply.code(404).send({ error: 'not_found' })
    clearRating(identifier, ctx.user.id)
    return { rating: getRating(identifier, ctx.user.id) }
  })
}
