/**
 * Public alternative-backends directory.
 *
 * A "backend" is any third-party BeamMP-compatible backend (e.g. a
 * Decentralized-BMP-V2 instance) that has been issued a token by a BMR
 * admin and POSTs heartbeats to `/api/backends/heartbeat`. Content Manager
 * fetches `/api/backends` and offers them to users as alternatives to the
 * official `backend.beammp.com`.
 *
 * Token format: opaque base64url(32 bytes). Stored on the server as the
 * SHA-256 of the token plus (for tokens minted via an approved user
 * request) the plaintext, so the operator can reveal it again on demand
 * — they no longer have to copy it down on first sight.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from '../db.js'

/** How long a backend may go without a heartbeat before it is hidden. */
export const LIVE_WINDOW_MS = 3 * 60 * 1000

export interface BackendTokenRow {
  id: number
  label: string
  token_hash: string
  created_at: number
  created_by: number | null
  revoked_at: number | null
  last_used_at: number | null
}

export interface BackendRow {
  id: number
  token_id: number
  url: string
  name: string
  region: string
  description: string
  launcher_version: string
  server_version: string
  active_servers: number
  active_players: number
  servers_json: string
  builds_json: string
  first_seen_at: number
  last_seen_at: number
}

export interface BackendServer {
  name: string
  players: number
  max_players: number
  map: string
  ip: string
  port: number
  last_heartbeat?: number
}

export interface BackendBuilds {
  /** Public download URL for the modified BeamMP-Server (Windows .exe). */
  server_windows?: string
  /** Public download URL for the modified BeamMP-Server (Linux binary). */
  server_linux?: string
  /** Public download URL for the modified BeamMP-Launcher. */
  launcher?: string
  /** Public download URL for the client-side mod ZIP. */
  client?: string
}

export interface PublicBackend {
  id: number
  url: string
  name: string
  region: string
  description: string
  launcher_version: string
  server_version: string
  active_servers: number
  active_players: number
  last_seen_at: number
  /**
   * Per-backend build URLs CM can download from. Optional; empty when the
   * operator hasn't published any.
   */
  builds: BackendBuilds
}

export interface PublicBackendDetail extends PublicBackend {
  first_seen_at: number
  servers: BackendServer[]
}

// ---------------------------------------------------------------------------
// Token mint / verify
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Mint a new backend operator token. The plaintext is returned ONCE; only
 * its SHA-256 hash is persisted.
 */
export function mintBackendToken(
  label: string,
  createdBy: number | null
): { id: number; token: string } {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = sha256Hex(token)
  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO backend_tokens (label, token_hash, created_at, created_by)
       VALUES (?, ?, ?, ?)`
    )
    .run(label, tokenHash, now, createdBy)
  return { id: Number(info.lastInsertRowid), token }
}

export function listBackendTokens(): Array<Omit<BackendTokenRow, 'token_hash'>> {
  return db
    .prepare<[], BackendTokenRow>(
      `SELECT id, label, token_hash, created_at, created_by, revoked_at, last_used_at
         FROM backend_tokens
         ORDER BY revoked_at IS NOT NULL, created_at DESC
         LIMIT 500`
    )
    .all()
    .map((r) => {
      const { token_hash: _h, ...rest } = r
      return rest
    })
}

export function revokeBackendToken(id: number): boolean {
  const info = db
    .prepare(
      `UPDATE backend_tokens
          SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL`
    )
    .run(Date.now(), id)
  if (info.changes === 0) return false
  // Cascade-clean: drop any backends published under this token so they
  // disappear from the public list immediately, not after the live window.
  db.prepare('DELETE FROM backends WHERE token_id = ?').run(id)
  return true
}

/**
 * Resolve a Bearer token to its backend_tokens row, in constant time vs.
 * other valid tokens. Returns null if no live (non-revoked) match.
 */
export function resolveBackendToken(plaintext: string): BackendTokenRow | null {
  if (!plaintext || plaintext.length < 16 || plaintext.length > 256) return null
  const candidate = sha256Hex(plaintext)
  const candidateBuf = Buffer.from(candidate, 'hex')

  // SQLite gives us O(log n) on the unique index. To stay timing-safe we
  // still do the final equality with timingSafeEqual.
  const row = db
    .prepare<[string], BackendTokenRow>(
      `SELECT * FROM backend_tokens WHERE token_hash = ? AND revoked_at IS NULL`
    )
    .get(candidate)
  if (!row) return null
  const stored = Buffer.from(row.token_hash, 'hex')
  if (stored.length !== candidateBuf.length) return null
  if (!timingSafeEqual(stored, candidateBuf)) return null
  return row
}

export function touchBackendToken(id: number): void {
  db.prepare('UPDATE backend_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), id)
}

// ---------------------------------------------------------------------------
// Heartbeat upsert
// ---------------------------------------------------------------------------

export interface HeartbeatInput {
  url: string
  name: string
  region?: string
  description?: string
  launcher_version?: string
  server_version?: string
  servers?: BackendServer[]
  active_servers?: number
  active_players?: number
  builds?: BackendBuilds
}

/**
 * Insert or update a backend listing. URL is the natural key; if a different
 * token previously claimed the same URL the upsert is rejected (URL ownership
 * is first-come-first-served until the original token is revoked).
 */
export function upsertBackend(
  tokenId: number,
  input: HeartbeatInput
): { ok: true; id: number } | { ok: false; error: 'url_owned_by_other_token' } {
  const now = Date.now()
  const existing = db
    .prepare<[string], { id: number; token_id: number }>(
      `SELECT id, token_id FROM backends WHERE url = ?`
    )
    .get(input.url)

  if (existing && existing.token_id !== tokenId) {
    return { ok: false, error: 'url_owned_by_other_token' }
  }

  const serversJson = JSON.stringify(input.servers ?? [])
  const buildsJson = JSON.stringify(input.builds ?? {})

  if (existing) {
    db.prepare(
      `UPDATE backends SET
         name = ?, region = ?, description = ?,
         launcher_version = ?, server_version = ?,
         active_servers = ?, active_players = ?,
         servers_json = ?, builds_json = ?,
         last_seen_at = ?
       WHERE id = ?`
    ).run(
      input.name,
      input.region ?? '',
      input.description ?? '',
      input.launcher_version ?? '',
      input.server_version ?? '',
      input.active_servers ?? 0,
      input.active_players ?? 0,
      serversJson,
      buildsJson,
      now,
      existing.id
    )
    return { ok: true, id: existing.id }
  }

  const info = db
    .prepare(
      `INSERT INTO backends
         (token_id, url, name, region, description,
          launcher_version, server_version,
          active_servers, active_players,
          servers_json, builds_json,
          first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      tokenId,
      input.url,
      input.name,
      input.region ?? '',
      input.description ?? '',
      input.launcher_version ?? '',
      input.server_version ?? '',
      input.active_servers ?? 0,
      input.active_players ?? 0,
      serversJson,
      buildsJson,
      now,
      now
    )
  return { ok: true, id: Number(info.lastInsertRowid) }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function parseBuilds(raw: string): BackendBuilds {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as BackendBuilds) : {}
  } catch {
    return {}
  }
}

function parseServers(raw: string): BackendServer[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as BackendServer[]) : []
  } catch {
    return []
  }
}

function rowToPublic(r: BackendRow): PublicBackend {
  return {
    id: r.id,
    url: r.url,
    name: r.name,
    region: r.region,
    description: r.description,
    launcher_version: r.launcher_version,
    server_version: r.server_version,
    active_servers: r.active_servers,
    active_players: r.active_players,
    last_seen_at: r.last_seen_at,
    builds: parseBuilds(r.builds_json),
  }
}

export function listLiveBackends(): PublicBackend[] {
  const cutoff = Date.now() - LIVE_WINDOW_MS
  const rows = db
    .prepare<[number], BackendRow>(
      `SELECT * FROM backends
        WHERE last_seen_at > ?
        ORDER BY active_players DESC, name ASC`
    )
    .all(cutoff)
  return rows.map(rowToPublic)
}

export function getBackendDetail(id: number): PublicBackendDetail | null {
  const r = db
    .prepare<[number], BackendRow>(`SELECT * FROM backends WHERE id = ?`)
    .get(id)
  if (!r) return null
  return {
    ...rowToPublic(r),
    first_seen_at: r.first_seen_at,
    servers: parseServers(r.servers_json),
  }
}

export function getBackendForToken(tokenId: number): PublicBackendDetail | null {
  const r = db
    .prepare<[number], BackendRow>(
      `SELECT * FROM backends WHERE token_id = ? ORDER BY last_seen_at DESC LIMIT 1`
    )
    .get(tokenId)
  if (!r) return null
  return {
    ...rowToPublic(r),
    first_seen_at: r.first_seen_at,
    servers: parseServers(r.servers_json),
  }
}

// ---------------------------------------------------------------------------
// Token requests (user-submitted, admin-reviewed)
// ---------------------------------------------------------------------------

export type BackendTokenRequestStatus = 'pending' | 'approved' | 'denied'

export interface BackendTokenRequestRow {
  id: number
  user_id: number
  label: string
  url: string
  region: string
  description: string
  message: string
  status: BackendTokenRequestStatus
  deny_reason: string
  token_id: number | null
  token_revealed: number
  requested_at: number
  reviewed_by: number | null
  reviewed_at: number | null
}

export interface BackendTokenRequestPublic {
  id: number
  label: string
  url: string
  region: string
  description: string
  message: string
  status: BackendTokenRequestStatus
  deny_reason: string
  requested_at: number
  reviewed_at: number | null
  /** True iff status='approved', a backing token row still exists, and that token has not been revoked. */
  token_available: boolean
  /** True iff the requester has called /reveal at least once. Informational only; reveal is not gated on it. */
  token_revealed: boolean
  /** True iff the backing token row was revoked by an admin. Reveal will refuse and the token will not authenticate any further heartbeats. */
  token_revoked: boolean
  /** Unix-ms timestamp of the revoke, or null if not revoked / no token. */
  token_revoked_at: number | null
}

export interface BackendTokenRequestAdminView extends BackendTokenRequestPublic {
  user_id: number
  user_email: string | null
  user_display_name: string | null
  reviewed_by: number | null
  reviewer_display_name: string | null
}

function rowToPublicRequest(
  r: BackendTokenRequestRow & { token_revoked_at?: number | null }
): BackendTokenRequestPublic {
  const revokedAt = r.token_revoked_at ?? null
  const revoked = revokedAt !== null
  return {
    id: r.id,
    label: r.label,
    url: r.url,
    region: r.region,
    description: r.description,
    message: r.message,
    status: r.status,
    deny_reason: r.deny_reason,
    requested_at: r.requested_at,
    reviewed_at: r.reviewed_at,
    // Token can be re-revealed by the requester while the request is
    // approved, a backing token row exists, AND that token hasn't been
    // revoked. Once revoked, the plaintext is useless so we hide the
    // reveal button entirely.
    token_available: r.status === 'approved' && r.token_id !== null && !revoked,
    token_revealed: r.token_revealed === 1,
    token_revoked: revoked,
    token_revoked_at: revokedAt,
  }
}

export interface CreateBackendTokenRequestInput {
  label: string
  url: string
  region?: string
  description?: string
  message?: string
}

export function createBackendTokenRequest(
  userId: number,
  input: CreateBackendTokenRequestInput
): { ok: true; id: number } | { ok: false; error: 'too_many_pending' | 'duplicate_url' } {
  // Block spam: one pending request per user at a time.
  const pendingForUser = db
    .prepare<[number], { c: number }>(
      `SELECT COUNT(*) AS c FROM backend_token_requests WHERE user_id = ? AND status = 'pending'`
    )
    .get(userId)
  if (pendingForUser && pendingForUser.c >= 3) {
    return { ok: false, error: 'too_many_pending' }
  }
  // Don't let a user queue a request for a URL they (or anyone) already
  // operate via an approved+live token.
  const claimed = db
    .prepare<[string], { id: number }>(`SELECT id FROM backends WHERE url = ?`)
    .get(input.url)
  if (claimed) return { ok: false, error: 'duplicate_url' }
  const now = Date.now()
  const info = db
    .prepare(
      `INSERT INTO backend_token_requests
         (user_id, label, url, region, description, message, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      input.label,
      input.url,
      input.region ?? '',
      input.description ?? '',
      input.message ?? '',
      now
    )
  return { ok: true, id: Number(info.lastInsertRowid) }
}

export function listBackendTokenRequestsForUser(
  userId: number
): BackendTokenRequestPublic[] {
  type Row = BackendTokenRequestRow & { token_revoked_at: number | null }
  return db
    .prepare<[number], Row>(
      `SELECT r.*, bt.revoked_at AS token_revoked_at
         FROM backend_token_requests r
         LEFT JOIN backend_tokens bt ON bt.id = r.token_id
        WHERE r.user_id = ?
        ORDER BY r.requested_at DESC
        LIMIT 100`
    )
    .all(userId)
    .map(rowToPublicRequest)
}

export function getBackendTokenRequestForUser(
  userId: number,
  id: number
): BackendTokenRequestRow | null {
  return (
    db
      .prepare<[number, number], BackendTokenRequestRow>(
        `SELECT * FROM backend_token_requests WHERE id = ? AND user_id = ?`
      )
      .get(id, userId) ?? null
  )
}

export function listAllBackendTokenRequests(
  status?: BackendTokenRequestStatus
): BackendTokenRequestAdminView[] {
  const sql = `
    SELECT r.*,
           u.email AS user_email, u.display_name AS user_display_name,
           rv.display_name AS reviewer_display_name,
           bt.revoked_at AS token_revoked_at
      FROM backend_token_requests r
      LEFT JOIN users u  ON u.id  = r.user_id
      LEFT JOIN users rv ON rv.id = r.reviewed_by
      LEFT JOIN backend_tokens bt ON bt.id = r.token_id
     ${status ? 'WHERE r.status = ?' : ''}
     ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
     LIMIT 500
  `
  type Row = BackendTokenRequestRow & {
    user_email: string | null
    user_display_name: string | null
    reviewer_display_name: string | null
    token_revoked_at: number | null
  }
  const rows = status
    ? db.prepare<[BackendTokenRequestStatus], Row>(sql).all(status)
    : db.prepare<[], Row>(sql).all()
  return rows.map((r) => ({
    ...rowToPublicRequest(r),
    user_id: r.user_id,
    user_email: r.user_email,
    user_display_name: r.user_display_name,
    reviewed_by: r.reviewed_by,
    reviewer_display_name: r.reviewer_display_name,
  }))
}

/**
 * Approve a request. Mints a new backend_tokens row in the same transaction
 * and links it to the request so the requester can reveal the plaintext
 * once via `revealApprovedBackendToken`. Returns null if the request
 * doesn't exist or is not pending.
 */
export function approveBackendTokenRequest(
  id: number,
  reviewerId: number
): { tokenId: number; label: string } | null {
  const req = db
    .prepare<[number], BackendTokenRequestRow>(
      `SELECT * FROM backend_token_requests WHERE id = ?`
    )
    .get(id)
  if (!req || req.status !== 'pending') return null
  const minted = mintBackendToken(req.label, reviewerId)
  // Stash the plaintext for the requester to retrieve once. We do that by
  // tucking it into the description column? No — separate column.
  db.prepare(
    `UPDATE backend_token_requests
        SET status = 'approved',
            token_id = ?,
            reviewed_by = ?,
            reviewed_at = ?,
            token_plaintext = ?
      WHERE id = ?`
  ).run(minted.id, reviewerId, Date.now(), minted.token, id)
  return { tokenId: minted.id, label: req.label }
}

export function denyBackendTokenRequest(
  id: number,
  reviewerId: number,
  reason: string
): boolean {
  const info = db
    .prepare(
      `UPDATE backend_token_requests
          SET status = 'denied',
              deny_reason = ?,
              reviewed_by = ?,
              reviewed_at = ?
        WHERE id = ? AND status = 'pending'`
    )
    .run(reason, reviewerId, Date.now(), id)
  return info.changes > 0
}

/**
 * Reveal the plaintext token for an approved request. The requester may
 * call this as many times as they like — the plaintext stays in the DB
 * for the lifetime of the request so they can retrieve it again after a
 * browser refresh, on a new device, etc. Returns null if the request
 * isn't approved, isn't owned by this user, or has no backing plaintext.
 */
export function revealApprovedBackendToken(
  userId: number,
  requestId: number
): { token: string; label: string } | null {
  type Row = BackendTokenRequestRow & {
    token_plaintext: string | null
    token_revoked_at: number | null
  }
  const row = db
    .prepare<[number, number], Row>(
      `SELECT r.*, bt.revoked_at AS token_revoked_at
         FROM backend_token_requests r
         LEFT JOIN backend_tokens bt ON bt.id = r.token_id
        WHERE r.id = ? AND r.user_id = ?`
    )
    .get(requestId, userId)
  if (!row) return null
  if (row.status !== 'approved') return null
  if (!row.token_plaintext) return null
  // Refuse to hand out a token that an admin has revoked — it can't
  // authenticate anyway and we don't want stale plaintext circulating.
  if (row.token_revoked_at !== null) return null
  // Mark as revealed at least once so the admin UI can surface that the
  // requester has actually seen the key. Plaintext is intentionally NOT
  // cleared — see function docstring.
  if (row.token_revealed === 0) {
    db.prepare(
      `UPDATE backend_token_requests SET token_revealed = 1 WHERE id = ?`
    ).run(requestId)
  }
  return { token: row.token_plaintext, label: row.label }
}
