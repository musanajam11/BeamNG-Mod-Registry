/**
 * Auth primitives: password hashing, session creation/validation, CSRF tokens.
 *
 * Sessions are server-side rows keyed by an opaque random ID stored in a
 * signed httpOnly cookie. CSRF uses the double-submit pattern: a non-httpOnly
 * cookie holds a token that the frontend mirrors in an `X-CSRF-Token` header
 * on all mutating requests.
 */
import argon2 from 'argon2'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { db, type SessionRow, type UserRow } from '../db.js'

const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 4,
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
export const SESSION_COOKIE = 'rw_sid'
export const CSRF_COOKIE = 'rw_csrf'
export const CSRF_HEADER = 'x-csrf-token'

const MAX_FAILED_LOGINS = 10
const LOCKOUT_MS = 15 * 60 * 1000

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTS)
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    return false
  }
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// ─── Sessions ────────────────────────────────────────────────────────────────

const insertSession = db.prepare(
  `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`
)
const selectSession = db.prepare<[string], SessionRow>(
  `SELECT * FROM sessions WHERE id = ?`
)
const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`)
const deleteExpiredSessions = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`)
const selectUser = db.prepare<[number], UserRow>(`SELECT * FROM users WHERE id = ?`)

export function createSession(userId: number, ip: string | null, ua: string | null): string {
  const id = newToken(32)
  const now = Date.now()
  insertSession.run(id, userId, now + SESSION_TTL_MS, ip, ua, now)
  return id
}

export function destroySession(sessionId: string): void {
  deleteSession.run(sessionId)
}

export interface SessionContext {
  user: UserRow
  session: SessionRow
}

export function loadSession(sessionId: string): SessionContext | null {
  const session = selectSession.get(sessionId)
  if (!session) return null
  if (session.expires_at < Date.now()) {
    deleteSession.run(sessionId)
    return null
  }
  const user = selectUser.get(session.user_id)
  if (!user) {
    deleteSession.run(sessionId)
    return null
  }
  return { user, session }
}

export function pruneExpiredSessions(): void {
  deleteExpiredSessions.run(Date.now())
}

// ─── Login throttling ───────────────────────────────────────────────────────

const incrementFailures = db.prepare(
  `UPDATE users
     SET failed_logins = failed_logins + 1,
         locked_until  = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END
   WHERE id = ?`
)
const resetFailures = db.prepare(
  `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?`
)

export function recordFailedLogin(userId: number): void {
  incrementFailures.run(MAX_FAILED_LOGINS, Date.now() + LOCKOUT_MS, userId)
}

export function recordSuccessfulLogin(userId: number): void {
  resetFailures.run(Date.now(), userId)
}

export function isLocked(user: UserRow): boolean {
  return user.locked_until !== null && user.locked_until > Date.now()
}
