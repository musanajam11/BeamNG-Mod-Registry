/**
 * One-off bootstrap helper: creates or upgrades an admin user.
 * Usage:  node --import tsx backend/src/cli/bootstrap-admin.ts <email> <password> [display_name]
 */
import argon2 from 'argon2'
import { db } from '../db.js'

const [, , emailArg, passwordArg, displayArg] = process.argv
if (!emailArg || !passwordArg) {
  console.error('Usage: bootstrap-admin <email> <password> [display_name]')
  process.exit(1)
}
const email = emailArg.toLowerCase()
const display = displayArg ?? 'admin'

const hash = await argon2.hash(passwordArg, {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 4,
})

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined

if (existing) {
  db.prepare(
    `UPDATE users SET password_hash = ?, role = 'admin', trust = 'green', failed_logins = 0, locked_until = NULL WHERE id = ?`
  ).run(hash, existing.id)
  console.log(`Updated user #${existing.id} (${email}) → admin/green`)
} else {
  const r = db
    .prepare(
      `INSERT INTO users (email, password_hash, display_name, role, trust, created_at)
       VALUES (?, ?, ?, 'admin', 'green', ?)`
    )
    .run(email, hash, display, Date.now())
  console.log(`Created admin user #${r.lastInsertRowid} (${email})`)
}
