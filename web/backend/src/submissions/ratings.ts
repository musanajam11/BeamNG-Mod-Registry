/**
 * Mod-rating helpers. Aggregations are computed on read from the
 * `mod_ratings` table; cheap at current scale.
 */
import { db } from '../db.js'

export interface RatingInfo {
  avg: number
  count: number
  /** Current user's own rating (1–5), or null if they haven't rated. */
  mine: number | null
}

export const EMPTY_RATING: RatingInfo = { avg: 0, count: 0, mine: null }

interface AggregateRow {
  identifier: string
  avg: number
  count: number
}

interface MineRow {
  identifier: string
  stars: number
}

/**
 * Aggregate ratings for every identifier in one pass, optionally joining
 * the current user's own rating. Returned map's `get(identifier)` returns
 * undefined for mods with no ratings — callers should fall back to
 * EMPTY_RATING.
 */
export function loadRatings(userId: number | null): Map<string, RatingInfo> {
  const aggRows = db
    .prepare<[], AggregateRow>(
      `SELECT identifier, AVG(stars) AS avg, COUNT(*) AS count
         FROM mod_ratings
        GROUP BY identifier`
    )
    .all()
  const out = new Map<string, RatingInfo>()
  for (const r of aggRows) {
    out.set(r.identifier, { avg: Number(r.avg) || 0, count: Number(r.count) || 0, mine: null })
  }
  if (userId !== null) {
    const mineRows = db
      .prepare<[number], MineRow>(
        `SELECT identifier, stars FROM mod_ratings WHERE user_id = ?`
      )
      .all(userId)
    for (const r of mineRows) {
      const cur = out.get(r.identifier)
      if (cur) cur.mine = r.stars
      else out.set(r.identifier, { avg: r.stars, count: 1, mine: r.stars })
    }
  }
  return out
}

export function getRating(identifier: string, userId: number | null): RatingInfo {
  const row = db
    .prepare<[string], { avg: number | null; count: number }>(
      `SELECT AVG(stars) AS avg, COUNT(*) AS count
         FROM mod_ratings WHERE identifier = ?`
    )
    .get(identifier)
  const info: RatingInfo = {
    avg: row && row.avg !== null ? Number(row.avg) : 0,
    count: row ? Number(row.count) : 0,
    mine: null,
  }
  if (userId !== null) {
    const mine = db
      .prepare<[number, string], { stars: number }>(
        `SELECT stars FROM mod_ratings WHERE user_id = ? AND identifier = ?`
      )
      .get(userId, identifier)
    if (mine) info.mine = mine.stars
  }
  return info
}

export function setRating(identifier: string, userId: number, stars: number): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO mod_ratings (user_id, identifier, stars, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, identifier) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at`
  ).run(userId, identifier, stars, now, now)
}

export function clearRating(identifier: string, userId: number): void {
  db.prepare(
    `DELETE FROM mod_ratings WHERE user_id = ? AND identifier = ?`
  ).run(userId, identifier)
}
