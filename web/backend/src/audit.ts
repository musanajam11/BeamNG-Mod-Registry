/**
 * Append an entry to the audit log. Best-effort; errors are swallowed and
 * logged so an audit failure never breaks a request.
 */
import { db } from './db.js'

export interface AuditEntry {
  actorId: number | null
  action: string
  target?: string | null
  details?: Record<string, unknown> | null
}

const insert = db.prepare(
  `INSERT INTO audit_log (actor_id, action, target, details_json, created_at)
   VALUES (?, ?, ?, ?, ?)`
)

export function audit(entry: AuditEntry): void {
  try {
    insert.run(
      entry.actorId,
      entry.action,
      entry.target ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
      Date.now()
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to record entry', err)
  }
}
