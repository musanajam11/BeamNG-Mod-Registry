/**
 * Invite-link routes (public, no auth required).
 *
 *   POST /api/invite
 *     Body: { ip: string, port: number }
 *     → { code: string, url: string }   — creates a short code (8-char base64url)
 *
 *   GET  /api/invite/:code
 *     → { ip: string, port: number }    — resolves a code (404 if expired/missing)
 *
 *   GET  /api/server-info?ip=...&port=...
 *     → BeamMP ServerInfo object         — server-side proxy to avoid CORS in browser
 *
 * Codes expire after 7 days and are pruned on write.
 */
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'

const TTL_MS = 7 * 24 * 60 * 60 * 1000
const IP_RE = /^[a-zA-Z0-9.\-:\[\]_]{1,64}$/
const CODE_RE = /^[A-Za-z0-9_-]{1,16}$/

export interface InviteLinkRow {
  ip: string
  port: number
}

export type BeamMpServerInfo = Record<string, unknown>

const CreateInviteBody = z.object({
  ip: z.string().regex(IP_RE, 'invalid ip'),
  port: z.number().int().min(1).max(65535),
})

function generateCode(): string {
  return randomBytes(6).toString('base64url').slice(0, 8)
}

function pruneExpired(): void {
  db.prepare('DELETE FROM invite_links WHERE created_at < ?').run(Date.now() - TTL_MS)
}

export function isValidInviteCode(code: string): boolean {
  return CODE_RE.test(code)
}

export function getInviteLink(code: string): InviteLinkRow | null {
  const row = db
    .prepare('SELECT ip, port FROM invite_links WHERE code = ? AND created_at >= ?')
    .get(code, Date.now() - TTL_MS) as InviteLinkRow | undefined

  return row ?? null
}

export async function fetchBeamMpServerInfo(
  ip: string,
  port: number,
  userAgent = 'bmr-invite-proxy/1.0'
): Promise<BeamMpServerInfo | null> {
  const res = await fetch('https://backend.beammp.com/servers-info', {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': userAgent },
  })
  if (!res.ok) {
    throw new Error(`upstream_error:${res.status}`)
  }

  const servers = (await res.json()) as BeamMpServerInfo[]
  const portStr = String(port)
  return servers.find((server) => String(server.ip) === ip && String(server.port) === portStr) ?? null
}

function extractMapSlug(raw: string): string {
  const input = raw.trim()
  const m = input.match(/\/levels\/([^/]+)/i)
  if (m?.[1]) return m[1]
  const parts = input.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? input
}

function mapSlugToLocationSlugs(slug: string): string[] {
  const s = slug.toLowerCase()
  const direct = s.replace(/_/g, '-')
  const aliases: Record<string, string[]> = {
    gridmap_v2: ['grid-small-pure', 'gridmap-v2'],
    east_coast_usa: ['east-coast-usa'],
    west_coast_usa: ['west-coast-usa'],
    jungle_rock_island: ['jungle-rock-island'],
    johnson_valley: ['johnson-valley'],
    hirochi_raceway: ['hirochi-raceway'],
    driver_training: ['driver-training'],
    industrial: ['industrial-site'],
  }
  const out = new Set<string>([direct])
  for (const a of aliases[s] ?? []) out.add(a)
  return [...out]
}

async function resolveStockMapThumbnail(slug: string): Promise<string | null> {
  const candidates = mapSlugToLocationSlugs(slug)
  for (const c of candidates) {
    const url = `https://www.beamng.com/game/locations/${encodeURIComponent(c)}/`
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'bmr-invite-map-thumb/1.0' },
      })
      if (!res.ok) continue
      const html = await res.text()
      const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
      const thumb = m?.[1]?.trim()
      if (thumb) return thumb
    } catch {
      // try next candidate
    }
  }
  return null
}

function resolveStaticMapThumbnail(slug: string): string | null {
  const exts = ['jpg', 'jpeg', 'png', 'webp']
  const dirs = [
    // Dev (workspace root = web)
    join(process.cwd(), 'frontend', 'public', 'map-thumbs'),
    // Dev (workspace root = web/backend)
    join(process.cwd(), '..', 'frontend', 'public', 'map-thumbs'),
    // Production container (/app)
    join(process.cwd(), 'frontend', 'dist', 'map-thumbs'),
    // Fallback variant
    join(process.cwd(), '..', 'frontend', 'dist', 'map-thumbs'),
  ]

  for (const ext of exts) {
    for (const dir of dirs) {
      const abs = join(dir, `${slug}.${ext}`)
      if (existsSync(abs)) return `/map-thumbs/${slug}.${ext}`
    }
  }
  return null
}

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/invite  — generate short code
  app.post<{ Body: unknown }>('/invite', {
    handler: async (req, reply) => {
      const parsed = CreateInviteBody.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_params', issues: parsed.error.issues })
      }
      const { ip, port } = parsed.data

      pruneExpired()

      let code = generateCode()
      for (let i = 0; i < 5; i++) {
        const existing = db.prepare('SELECT code FROM invite_links WHERE code = ?').get(code)
        if (!existing) break
        code = generateCode()
      }

      db.prepare(
        'INSERT INTO invite_links (code, ip, port, created_at) VALUES (?, ?, ?, ?)'
      ).run(code, ip, port, Date.now())

      return reply.send({ code, url: `${config.publicOrigin}/j/${code}` })
    },
  })

  // GET /api/invite/:code  — resolve code
  app.get<{ Params: { code: string } }>('/invite/:code', {
    handler: async (req, reply) => {
      const { code } = req.params
      if (!isValidInviteCode(code)) {
        return reply.status(400).send({ error: 'invalid_code' })
      }
      const row = getInviteLink(code)

      if (!row) return reply.status(404).send({ error: 'not_found' })
      return reply.send({ ip: row.ip, port: row.port })
    },
  })

  // GET /api/server-info?ip=...&port=...  — proxy BeamMP servers-info
  app.get<{ Querystring: { ip?: string; port?: string } }>('/server-info', {
    handler: async (req, reply) => {
      const { ip, port } = req.query
      if (!ip || !port) {
        return reply.status(400).send({ error: 'ip_and_port_required' })
      }
      if (!IP_RE.test(ip) || isNaN(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
        return reply.status(400).send({ error: 'invalid_params' })
      }
      try {
        const server = await fetchBeamMpServerInfo(ip, Number(port))
        if (!server) return reply.status(404).send({ error: 'server_not_found' })
        return reply.send(server)
      } catch (err) {
        req.log.warn({ err }, 'server-info: upstream fetch failed')
        return reply.status(502).send({ error: 'upstream_unavailable' })
      }
    },
  })

  // GET /api/invite/map-thumbnail?map=/levels/foo/...  — resolve stock map thumb
  app.get<{ Querystring: { map?: string } }>('/invite/map-thumbnail', {
    handler: async (req, reply) => {
      const raw = String(req.query.map ?? '').trim()
      if (!raw) return reply.status(400).send({ error: 'map_required' })

      const slug = extractMapSlug(raw)

      // Best source: static thumbnail pack exported from CM/local BeamNG assets
      // and deployed with BMR frontend as /map-thumbs/<slug>.<ext>.
      const localThumb = resolveStaticMapThumbnail(slug)
      if (localThumb) return reply.send({ thumbnail: localThumb })

      const thumbnail = await resolveStockMapThumbnail(slug)
      if (!thumbnail) return reply.status(404).send({ error: 'thumbnail_not_found' })
      return reply.send({ thumbnail })
    },
  })
}
