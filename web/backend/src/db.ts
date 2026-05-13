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
  {
    id: '004-user-avatar',
    // Stored as a data: URL (base64) capped client-side at ~512 KB. Keeps the
    // deployment a single SQLite file with no extra volume/static-serving setup.
    up: `
      ALTER TABLE users ADD COLUMN avatar_url TEXT;
    `,
  },
  {
    id: '005-mod-ratings',
    // One rating per user per mod identifier. Aggregated on read (cheap at
    // current scale; can be denormalised later if the registry grows).
    up: `
      CREATE TABLE mod_ratings (
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        identifier  TEXT NOT NULL,
        stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (user_id, identifier)
      );
      CREATE INDEX idx_mod_ratings_identifier ON mod_ratings(identifier);
    `,
  },
  {
    id: '006-submission-kind-delete',
    // Add 'delete' to the kind CHECK constraint so the registry can accept
    // mod-removal submissions (owner self-delete or non-owner takedown
    // request, both gated on admin approval). Same table-rebuild dance as
    // 003 since SQLite can't ALTER a CHECK in place.
    up: `
      CREATE TABLE submissions_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL CHECK (kind IN
                        ('manual_beammod','netbeammod_github','netbeammod_beamng',
                         'claim','new_version','delete')),
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
  {
    id: '007-invite-links',
    up: `
      CREATE TABLE invite_links (
        code       TEXT PRIMARY KEY,
        ip         TEXT NOT NULL,
        port       INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_invite_links_created ON invite_links(created_at);
    `,
  },
  {
    id: '008-backends',
    // Public directory of alternative BeamMP backends. Each registered backend
    // (a Decentralized-BMP-V2 instance, etc.) holds a `backend_tokens` row
    // and POSTs heartbeats to /api/backends/heartbeat to keep its `backends`
    // entry alive. Content Manager pulls GET /api/backends to populate its
    // backend-selection dropdown. Stale entries (no heartbeat for >3 min) are
    // filtered out at read time; a janitor can hard-delete them later.
    up: `
      CREATE TABLE backend_tokens (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        label        TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   INTEGER NOT NULL,
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        revoked_at   INTEGER,
        last_used_at INTEGER
      );
      CREATE INDEX idx_backend_tokens_revoked ON backend_tokens(revoked_at);

      CREATE TABLE backends (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id          INTEGER NOT NULL REFERENCES backend_tokens(id) ON DELETE CASCADE,
        url               TEXT NOT NULL UNIQUE,
        name              TEXT NOT NULL,
        region            TEXT NOT NULL DEFAULT '',
        description       TEXT NOT NULL DEFAULT '',
        launcher_version  TEXT NOT NULL DEFAULT '',
        server_version    TEXT NOT NULL DEFAULT '',
        active_servers    INTEGER NOT NULL DEFAULT 0,
        active_players    INTEGER NOT NULL DEFAULT 0,
        servers_json      TEXT NOT NULL DEFAULT '[]',
        builds_json       TEXT NOT NULL DEFAULT '{}',
        first_seen_at     INTEGER NOT NULL,
        last_seen_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_backends_token ON backends(token_id);
      CREATE INDEX idx_backends_last_seen ON backends(last_seen_at);
    `,
  },
  {
    id: '009-backend-token-requests',
    // User-submitted requests to be issued a backend operator token. Lets
    // anyone with an account ask for a key from the public "Backends"
    // surface; admins approve / deny in the admin panel. On approval we
    // mint a backend_tokens row and link it here so the requester can
    // reveal the plaintext exactly once.
    up: `
      CREATE TABLE backend_token_requests (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label           TEXT NOT NULL,
        url             TEXT NOT NULL,
        region          TEXT NOT NULL DEFAULT '',
        description     TEXT NOT NULL DEFAULT '',
        message         TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'pending',
        deny_reason     TEXT NOT NULL DEFAULT '',
        token_id        INTEGER REFERENCES backend_tokens(id) ON DELETE SET NULL,
        token_revealed  INTEGER NOT NULL DEFAULT 0,
        token_plaintext TEXT,
        requested_at    INTEGER NOT NULL,
        reviewed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at     INTEGER
      );
      CREATE INDEX idx_btr_user ON backend_token_requests(user_id);
      CREATE INDEX idx_btr_status ON backend_token_requests(status);
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
  | 'delete'
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
  avatar_url: string | null
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
