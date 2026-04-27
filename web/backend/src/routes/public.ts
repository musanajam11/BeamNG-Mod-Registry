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
import { getRegistry, summarize } from '../registry/index.js'
import { getTheme } from '../settings.js'

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

/**
 * Aggregate ratings for every mod identifier that has at least one rating.
 * Used by the listing endpoint to attach `{avg, count}` per card. SQLite
 * AVG returns a float; we round to one decimal at the API boundary so the
 * frontend doesn't have to deal with `4.333333…`.
 */
interface RatingAggRow {
  identifier: string
  avg: number
  count: number
}
function loadRatingAggregates(): Map<string, { avg: number; count: number }> {
  const rows = db
    .prepare(
      `SELECT identifier, AVG(stars) AS avg, COUNT(*) AS count
         FROM mod_ratings
        GROUP BY identifier`
    )
    .all() as RatingAggRow[]
  const out = new Map<string, { avg: number; count: number }>()
  for (const r of rows) {
    out.set(r.identifier, { avg: Math.round(r.avg * 10) / 10, count: r.count })
  }
  return out
}

function getRatingAggregate(identifier: string): { avg: number; count: number } {
  const row = db
    .prepare(
      `SELECT AVG(stars) AS avg, COUNT(*) AS count
         FROM mod_ratings
        WHERE identifier = ?`
    )
    .get(identifier) as { avg: number | null; count: number }
  return {
    avg: row.avg ? Math.round(row.avg * 10) / 10 : 0,
    count: row.count,
  }
}

function loadUserRatings(userId: number): Map<string, number> {
  const rows = db
    .prepare(`SELECT identifier, stars FROM mod_ratings WHERE user_id = ?`)
    .all(userId) as Array<{ identifier: string; stars: number }>
  const out = new Map<string, number>()
  for (const r of rows) out.set(r.identifier, r.stars)
  return out
}

function getUserRating(userId: number, identifier: string): number | null {
  const row = db
    .prepare(`SELECT stars FROM mod_ratings WHERE user_id = ? AND identifier = ?`)
    .get(userId, identifier) as { stars: number } | undefined
  return row ? row.stars : null
}

const QuerySchema = z.object({
  q: z.string().trim().max(128).optional(),
  type: z.string().trim().max(32).optional(),
  tag: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
})

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
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const parsed = QuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues })
    }
    const { q, type, tag } = parsed.data
    const page = parsed.data.page ?? 1
    const pageSize = parsed.data.pageSize ?? 24

    const { entries } = await getRegistry()
    let filtered = entries
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

    const total = filtered.length
    const start = (page - 1) * pageSize
    const slice = filtered.slice(start, start + pageSize)

    // Aggregate facet counts off the *unfiltered* set so users can see what
    // else is available; cheap because the index is in memory.
    const typeCounts: Record<string, number> = {}
    for (const m of entries) {
      if (m.mod_type) typeCounts[m.mod_type] = (typeCounts[m.mod_type] ?? 0) + 1
    }

    // Single SQL pass for last-editor attribution; cheap (one indexed scan)
    // and avoids N+1 lookups from the client.
    const lastEdits = loadLastEdits()
    const ratings = loadRatingAggregates()
    const userRatings = loadUserRatings(ctx.user.id)

    return {
      items: slice.map((m) => {
        const agg = ratings.get(m.identifier) ?? { avg: 0, count: 0 }
        return {
          ...summarize(m),
          last_edit: lastEdits.get(m.identifier) ?? null,
          rating: {
            avg: agg.avg,
            count: agg.count,
            mine: userRatings.get(m.identifier) ?? null,
          },
        }
      }),
      total,
      page,
      pageSize,
      facets: { mod_types: typeCounts },
    }
  })

  // Edit history for one mod — every accepted submission, newest first.
  // Used by the registry browser drawer to show who has touched the entry.
  app.get('/mods/:identifier/history', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const { identifier } = request.params as { identifier: string }
    const { byId } = await getRegistry()
    if (!byId.has(identifier)) return reply.code(404).send({ error: 'not_found' })
    return { history: loadHistory(identifier) }
  })

  app.get('/mods/:identifier', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
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
      rating: {
        ...getRatingAggregate(identifier),
        mine: getUserRating(ctx.user.id, identifier),
      },
    }
  })

  // ─── Ratings ───────────────────────────────────────────────────────────
  // 1-5 stars per (user, identifier). PUT upserts; DELETE clears the user's
  // own rating. Aggregate is returned in the response so the client can
  // optimistically refresh without a second round-trip.
  const RatingSchema = z.object({ stars: z.number().int().min(1).max(5) })

  app.put('/mods/:identifier/rating', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const { identifier } = request.params as { identifier: string }
    const { byId } = await getRegistry()
    if (!byId.has(identifier)) return reply.code(404).send({ error: 'not_found' })
    const parsed = RatingSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues })
    }
    const now = Date.now()
    db.prepare(
      `INSERT INTO mod_ratings (user_id, identifier, stars, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, identifier) DO UPDATE SET
         stars = excluded.stars,
         updated_at = excluded.updated_at`
    ).run(ctx.user.id, identifier, parsed.data.stars, now, now)
    return {
      rating: {
        ...getRatingAggregate(identifier),
        mine: parsed.data.stars,
      },
    }
  })

  app.delete('/mods/:identifier/rating', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const { identifier } = request.params as { identifier: string }
    db.prepare(`DELETE FROM mod_ratings WHERE user_id = ? AND identifier = ?`).run(
      ctx.user.id,
      identifier,
    )
    return {
      rating: {
        ...getRatingAggregate(identifier),
        mine: null,
      },
    }
  })
}
