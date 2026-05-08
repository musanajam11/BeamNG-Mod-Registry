/**
 * Public backends directory routes.
 *
 *   POST /api/backends/heartbeat
 *     Auth:   Authorization: Bearer <backend-token>
 *     Body:   { url, name, region?, description?, launcher_version?,
 *               server_version?, servers?, active_servers?, active_players?,
 *               builds? }
 *     → 204 No Content
 *
 *   GET  /api/backends
 *     → { backends: PublicBackend[] }   — only entries with a heartbeat
 *                                          inside the last LIVE_WINDOW_MS.
 *
 *   GET  /api/backends/:id
 *     → PublicBackendDetail | 404
 *
 *   GET  /api/backends/me
 *     Auth:   Authorization: Bearer <backend-token>
 *     → { token: { id, label }, backend: PublicBackendDetail | null }
 *
 *   GET  /api/backends/requests/me               (session-auth)
 *     → { requests: BackendTokenRequestPublic[] }
 *
 *   POST /api/backends/requests                  (session-auth)
 *     Body: { label, url, region?, description?, message? }
 *     → { id }
 *
 *   POST /api/backends/requests/:id/reveal       (session-auth)
 *     One-shot reveal of an approved request's plaintext token.
 *     → { token, label }
 *
 * Admin-side token mint/revoke endpoints live in `admin/routes.ts`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  createBackendTokenRequest,
  getBackendDetail,
  getBackendForToken,
  listBackendTokenRequestsForUser,
  listLiveBackends,
  resolveBackendToken,
  revealApprovedBackendToken,
  touchBackendToken,
  upsertBackend,
  type BackendTokenRow,
} from '../backends/index.js'
import { requireAuth } from '../auth/plugin.js'

const URL_RE = /^https?:\/\/[A-Za-z0-9.\-]+(?::\d+)?(?:\/[\w\-./%]*)?$/

const HeartbeatBody = z.object({
  url: z.string().regex(URL_RE, 'invalid url').max(256),
  name: z.string().trim().min(1).max(80),
  region: z.string().trim().max(64).optional(),
  description: z.string().trim().max(512).optional(),
  launcher_version: z.string().trim().max(32).optional(),
  server_version: z.string().trim().max(32).optional(),
  servers: z
    .array(
      z.object({
        // BeamMP server names can carry color/style codes (`^6^l...`)
        // that inflate the byte count well past the visible length, and
        // the upstream protocol allows up to ~256 chars. Be generous.
        name: z.string().max(512).default(''),
        players: z.number().int().min(0).max(10_000).default(0),
        max_players: z.number().int().min(0).max(10_000).default(0),
        map: z.string().max(256).default(''),
        ip: z.string().max(64).default(''),
        port: z.number().int().min(0).max(65535).default(0),
        last_heartbeat: z.number().int().optional(),
      })
    )
    .max(500)
    .optional(),
  active_servers: z.number().int().min(0).max(10_000).optional(),
  active_players: z.number().int().min(0).max(1_000_000).optional(),
  builds: z
    .object({
      server_windows: z.string().regex(URL_RE).max(512).optional(),
      server_linux: z.string().regex(URL_RE).max(512).optional(),
      launcher: z.string().regex(URL_RE).max(512).optional(),
      client: z.string().regex(URL_RE).max(512).optional(),
    })
    .optional(),
  /** Operator clock; informational only — server uses its own time. */
  ts: z.number().int().optional(),
})

function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(h)
  if (!m || !m[1]) return null
  return m[1].trim()
}

function authBackend(req: FastifyRequest): BackendTokenRow | null {
  const t = extractBearer(req)
  if (!t) return null
  return resolveBackendToken(t)
}

export async function backendsRoutes(app: FastifyInstance): Promise<void> {
  // ---------- public read ----------
  app.get('/', async () => ({ backends: listLiveBackends() }))

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const id = Number(request.params.id)
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid_id' })
    }
    const b = getBackendDetail(id)
    if (!b) return reply.code(404).send({ error: 'not_found' })
    return b
  })

  // ---------- backend operator (Bearer token) ----------
  app.get('/me', async (request, reply) => {
    const tok = authBackend(request)
    if (!tok) return reply.code(401).send({ error: 'invalid_token' })
    return {
      token: { id: tok.id, label: tok.label },
      backend: getBackendForToken(tok.id),
    }
  })

  app.post('/heartbeat', async (request, reply) => {
    const tok = authBackend(request)
    if (!tok) return reply.code(401).send({ error: 'invalid_token' })

    const parsed = HeartbeatBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      })
    }

    const result = upsertBackend(tok.id, parsed.data)
    if (!result.ok) {
      return reply.code(409).send({ error: result.error })
    }
    touchBackendToken(tok.id)
    return reply.code(204).send()
  })

  // ---------- user-facing token request flow (session-auth) ----------
  // Lets any signed-in user ask for a backend operator token from the
  // public Backends surface. Admins approve in the admin panel; on
  // approval the user can reveal the plaintext exactly once.

  const RequestBody = z.object({
    label: z.string().trim().min(1).max(80),
    url: z.string().regex(URL_RE, 'invalid url').max(256),
    region: z.string().trim().max(64).optional(),
    description: z.string().trim().max(512).optional(),
    message: z.string().trim().max(1000).optional(),
  })

  app.get('/requests/me', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    return { requests: listBackendTokenRequestsForUser(ctx.user.id) }
  })

  app.post('/requests', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const parsed = RequestBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      })
    }
    const r = createBackendTokenRequest(ctx.user.id, parsed.data)
    if (!r.ok) return reply.code(409).send({ error: r.error })
    return { id: r.id }
  })

  app.post<{ Params: { id: string } }>('/requests/:id/reveal', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const id = Number(request.params.id)
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid_id' })
    }
    const out = revealApprovedBackendToken(ctx.user.id, id)
    if (!out) return reply.code(404).send({ error: 'not_revealable' })
    return out
  })
}
