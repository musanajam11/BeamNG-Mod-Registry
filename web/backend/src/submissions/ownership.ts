/**
 * Mod identifier ownership helpers.
 *
 * Rules:
 *  - A brand-new identifier (no on-disk entry, no DB owner) auto-claims to
 *    the first submitter; nothing to dispute.
 *  - For identifiers already on disk but unowned, users must explicitly
 *    submit a `claim` (kind='claim') which is reviewed by green-tier
 *    reviewers; on approval ownership is transferred.
 *  - Once owned, the owner is the sole approver of further submissions
 *    (admins always bypass). Other users may still submit edits, but they
 *    are routed to the owner's review queue, not the global queue.
 */
import { db } from '../db.js'

interface OwnershipRow {
  identifier: string
  user_id: number
  claimed_at: number
}

export interface OwnerInfo {
  identifier: string
  user_id: number
  display_name: string
  avatar_url: string | null
  claimed_at: number
}

const selectOwner = db.prepare<[string], OwnershipRow>(
  `SELECT * FROM mod_ownership WHERE identifier = ?`
)
const insertOwner = db.prepare(
  `INSERT INTO mod_ownership (identifier, user_id, claimed_at) VALUES (?, ?, ?)
   ON CONFLICT(identifier) DO NOTHING`
)
const upsertOwner = db.prepare(
  `INSERT INTO mod_ownership (identifier, user_id, claimed_at) VALUES (?, ?, ?)
   ON CONFLICT(identifier) DO UPDATE SET user_id = excluded.user_id, claimed_at = excluded.claimed_at`
)

export function getOwner(identifier: string): number | null {
  const row = selectOwner.get(identifier)
  return row ? row.user_id : null
}

export function getOwnerInfo(identifier: string): OwnerInfo | null {
  const row = db
    .prepare<[string], OwnerInfo>(
      `SELECT o.identifier, o.user_id, o.claimed_at, u.display_name, u.avatar_url
         FROM mod_ownership o
         JOIN users u ON u.id = o.user_id
        WHERE o.identifier = ?`
    )
    .get(identifier)
  return row ?? null
}

export function loadOwners(): Map<string, OwnerInfo> {
  const rows = db
    .prepare<[], OwnerInfo>(
      `SELECT o.identifier, o.user_id, o.claimed_at, u.display_name, u.avatar_url
         FROM mod_ownership o
         JOIN users u ON u.id = o.user_id`
    )
    .all()
  const out = new Map<string, OwnerInfo>()
  for (const r of rows) out.set(r.identifier, r)
  return out
}

export function listOwnedByUser(userId: number): OwnerInfo[] {
  return db
    .prepare<[number], OwnerInfo>(
      `SELECT o.identifier, o.user_id, o.claimed_at, u.display_name, u.avatar_url
         FROM mod_ownership o
         JOIN users u ON u.id = o.user_id
        WHERE o.user_id = ?
        ORDER BY o.claimed_at DESC`
    )
    .all(userId)
}

export function claimIfUnowned(identifier: string, userId: number): void {
  insertOwner.run(identifier, userId, Date.now())
}

export function transferOwnership(identifier: string, userId: number): void {
  upsertOwner.run(identifier, userId, Date.now())
}

/**
 * Remove ownership of an identifier — the mod becomes unclaimed and any
 * future third-party edits route back to the global reviewer queue. Used
 * when an owner relinquishes control via the dashboard.
 */
export function releaseOwnership(identifier: string, userId: number): boolean {
  const result = db
    .prepare(`DELETE FROM mod_ownership WHERE identifier = ? AND user_id = ?`)
    .run(identifier, userId)
  return result.changes > 0
}

/**
 * @deprecated Submissions are no longer blocked by ownership at the
 * `/manual` boundary; see `/manual` route for the new routing rules.
 * Retained as a low-level predicate for places that still want it.
 */
export function canSubmit(identifier: string, userId: number, isAdmin: boolean): boolean {
  if (isAdmin) return true
  const owner = getOwner(identifier)
  return owner === null || owner === userId
}
