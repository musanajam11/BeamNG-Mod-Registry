/**
 * SQLite database singleton and schema migrations.
 *
 * Migrations are tracked in the `schema_migrations` table. Each migration is
 * idempotent and runs in a transaction.
 */
import Database from 'better-sqlite3'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { config } from './config.js'

mkdirSync(dirname(config.databasePath), { recursive: true })

export const db = new Database(config.databasePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('synchronous = NORMAL')

interface Migration {
  id: string
  up: string
}

const MIGRATIONS: Migration[] = [
  {
    id: '001-initial',
    up: `
      CREATE TABLE users (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash   TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
        trust           TEXT NOT NULL DEFAULT 'yellow' CHECK (trust IN ('green','yellow','red')),
        github_username TEXT,
        email_verified  INTEGER NOT NULL DEFAULT 0,
        failed_logins   INTEGER NOT NULL DEFAULT 0,
        locked_until    INTEGER,
        created_at      INTEGER NOT NULL,
        last_login_at   INTEGER
      );

      CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at  INTEGER NOT NULL,
        ip          TEXT,
        user_agent  TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE mod_ownership (
        identifier  TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        claimed_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_ownership_user ON mod_ownership(user_id);

      CREATE TABLE submissions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL CHECK (kind IN
                        ('manual_beammod','netbeammod_github','netbeammod_beamng',
                         'claim','new_version')),
        identifier    TEXT NOT NULL,
        version       TEXT,
        payload_json  TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN
                        ('pending_review','queued','processing',
                         'pr_opened','merged','rejected','failed')),
        pr_url        TEXT,
        branch        TEXT,
        reviewer_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        review_note   TEXT,
        error         TEXT,
        created_at    INTEGER NOT NULL,
        decided_at    INTEGER
      );
      CREATE INDEX idx_submissions_user ON submissions(user_id);
      CREATE INDEX idx_submissions_status ON submissions(status);
      CREATE INDEX idx_submissions_identifier ON submissions(identifier);

      CREATE TABLE audit_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action        TEXT NOT NULL,
        target        TEXT,
        details_json  TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_audit_actor ON audit_log(actor_id);
      CREATE INDEX idx_audit_created ON audit_log(created_at);

      CREATE TABLE rate_limit (
        key           TEXT PRIMARY KEY,
        count         INTEGER NOT NULL,
        window_start  INTEGER NOT NULL
      );
    `,
  },
  {
    id: '002-settings',
    up: `
      CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
    `,
  },
  {
    id: '003-submission-status-changes-requested',
    // SQLite can't ALTER a CHECK constraint in place; the canonical recipe is
    // table-rebuild. No other table FKs into `submissions`, so we don't need
    // to toggle PRAGMA foreign_keys (which would be a no-op inside the
    // migration transaction anyway).
    up: `
      CREATE TABLE submissions_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL CHECK (kind IN
                        ('manual_beammod','netbeammod_github','netbeammod_beamng',
                         'claim','new_version')),
        identifier    TEXT NOT NULL,
        version       TEXT,
        payload_json  TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN
                        ('pending_review','changes_requested','queued','processing',
                         'pr_opened','merged','rejected','failed')),
        pr_url        TEXT,
        branch        TEXT,
        reviewer_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        review_note   TEXT,
        error         TEXT,
        created_at    INTEGER NOT NULL,
        decided_at    INTEGER
      );
      INSERT INTO submissions_new
        SELECT id, user_id, kind, identifier, version, payload_json, status,
               pr_url, branch, reviewer_id, review_note, error, created_at, decided_at
          FROM submissions;
      DROP TABLE submissions;
      ALTER TABLE submissions_new RENAME TO submissions;
      CREATE INDEX idx_submissions_user ON submissions(user_id);
      CREATE INDEX idx_submissions_status ON submissions(status);
      CREATE INDEX idx_submissions_identifier ON submissions(identifier);
    `,
  },
]

function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `)
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: string }).id)
  )
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    const tx = db.transaction(() => {
      db.exec(m.up)
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        m.id,
        Date.now()
      )
    })
    tx()
  }
}

runMigrations()

export type UserRole = 'user' | 'admin'
export type TrustTier = 'green' | 'yellow' | 'red'
export type SubmissionKind =
  | 'manual_beammod'
  | 'netbeammod_github'
  | 'netbeammod_beamng'
  | 'claim'
  | 'new_version'
export type SubmissionStatus =
  | 'pending_review'
  | 'changes_requested'
  | 'queued'
  | 'processing'
  | 'pr_opened'
  | 'merged'
  | 'rejected'
  | 'failed'

export interface UserRow {
  id: number
  email: string
  password_hash: string
  display_name: string
  role: UserRole
  trust: TrustTier
  github_username: string | null
  email_verified: number
  failed_logins: number
  locked_until: number | null
  created_at: number
  last_login_at: number | null
}

export interface SessionRow {
  id: string
  user_id: number
  expires_at: number
  ip: string | null
  user_agent: string | null
  created_at: number
}

export interface SubmissionRow {
  id: number
  user_id: number
  kind: SubmissionKind
  identifier: string
  version: string | null
  payload_json: string
  status: SubmissionStatus
  pr_url: string | null
  branch: string | null
  reviewer_id: number | null
  review_note: string | null
  error: string | null
  created_at: number
  decided_at: number | null
}
