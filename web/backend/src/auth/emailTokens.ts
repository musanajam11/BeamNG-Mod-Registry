/**
 * Single-use email verification tokens. Persisted server-side so revocation
 * is trivial and we don't depend on a JWT secret.
 */
import { randomBytes, createHash } from 'node:crypto'
import { db } from '../db.js'

const TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

db.exec(`
  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens(user_id);
`)

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createEmailVerificationToken(userId: number): string {
  // Invalidate any older outstanding tokens so each new request supersedes
  // the previous link.
  db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(userId)
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  db.prepare(
    `INSERT INTO email_verification_tokens (token_hash, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(hashToken(token), userId, now + TTL_MS, now)
  return token
}

/**
 * Consumes a token. Returns the userId on success, or null if invalid/expired.
 */
export function consumeEmailVerificationToken(token: string): number | null {
  const row = db
    .prepare<[string], { user_id: number; expires_at: number }>(
      'SELECT user_id, expires_at FROM email_verification_tokens WHERE token_hash = ?'
    )
    .get(hashToken(token))
  if (!row) return null
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM email_verification_tokens WHERE token_hash = ?').run(hashToken(token))
    return null
  }
  // Single use.
  db.prepare('DELETE FROM email_verification_tokens WHERE token_hash = ?').run(hashToken(token))
  return row.user_id
}

export function pruneExpiredEmailVerificationTokens(): void {
  db.prepare('DELETE FROM email_verification_tokens WHERE expires_at < ?').run(Date.now())
}
