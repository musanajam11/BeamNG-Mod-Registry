/**
 * Mod identifier ownership helpers.
 *
 * Rules:
 *  - The first user to submit a brand-new identifier claims it.
 *  - Subsequent versions of an existing identifier may only be submitted by
 *    the claiming user (or an admin).
 *  - "Claim auto-scraped" submissions transfer ownership atomically when
 *    approved.
 */
import { db } from '../db.js'

interface OwnershipRow {
  identifier: string
  user_id: number
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

export function claimIfUnowned(identifier: string, userId: number): void {
  insertOwner.run(identifier, userId, Date.now())
}

export function transferOwnership(identifier: string, userId: number): void {
  upsertOwner.run(identifier, userId, Date.now())
}

export function canSubmit(identifier: string, userId: number, isAdmin: boolean): boolean {
  if (isAdmin) return true
  const owner = getOwner(identifier)
  return owner === null || owner === userId
}
