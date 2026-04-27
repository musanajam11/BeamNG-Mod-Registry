/**
 * Runtime settings stored in the `settings` table.
 *
 * Values stored here override the corresponding process.env values from
 * config.ts, so admins can configure GitHub App credentials at runtime
 * without restarting the container. The cache is invalidated on every
 * write.
 */
import { db } from './db.js'
import { config } from './config.js'

interface SettingsRow {
  key: string
  value: string
}

const stmtGetAll = db.prepare<[], SettingsRow>('SELECT key, value FROM settings')
const stmtGetOne = db.prepare<[string], SettingsRow>('SELECT key, value FROM settings WHERE key = ?')
const stmtUpsert = db.prepare(
  `INSERT INTO settings (key, value, updated_at, updated_by)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                  updated_at = excluded.updated_at,
                                  updated_by = excluded.updated_by`
)
const stmtDelete = db.prepare('DELETE FROM settings WHERE key = ?')

let cache: Map<string, string> | null = null
function getMap(): Map<string, string> {
  if (!cache) {
    cache = new Map(stmtGetAll.all().map((r) => [r.key, r.value]))
  }
  return cache
}
function invalidate(): void {
  cache = null
}

export function getSetting(key: string): string | undefined {
  return getMap().get(key)
}

export function setSetting(key: string, value: string, actorId: number | null): void {
  if (value === '') {
    stmtDelete.run(key)
  } else {
    stmtUpsert.run(key, value, Date.now(), actorId)
  }
  invalidate()
}

/**
 * Resolved GitHub App configuration. DB values take precedence over env vars
 * so admins can override at runtime via the settings UI.
 */
export interface ResolvedGithubConfig {
  appId?: string
  privateKey?: string
  installationId?: string
  repoOwner?: string
  repoName: string
  defaultBranch: string
  autoMerge: boolean
}

export const GITHUB_KEYS = {
  appId: 'github.app_id',
  privateKey: 'github.private_key',
  installationId: 'github.installation_id',
  repoOwner: 'github.repo_owner',
  repoName: 'github.repo_name',
  defaultBranch: 'github.default_branch',
  autoMerge: 'github.auto_merge',
} as const

export function getGithubConfig(): ResolvedGithubConfig {
  const m = getMap()
  const fromDb = (k: string) => m.get(k)
  const autoMergeRaw = fromDb(GITHUB_KEYS.autoMerge)
  return {
    appId: fromDb(GITHUB_KEYS.appId) ?? config.github.appId,
    privateKey: fromDb(GITHUB_KEYS.privateKey) ?? config.github.privateKey,
    installationId: fromDb(GITHUB_KEYS.installationId) ?? config.github.installationId,
    repoOwner: fromDb(GITHUB_KEYS.repoOwner) ?? config.github.repoOwner,
    repoName: fromDb(GITHUB_KEYS.repoName) ?? config.github.repoName,
    defaultBranch: fromDb(GITHUB_KEYS.defaultBranch) ?? config.github.defaultBranch,
    autoMerge:
      autoMergeRaw !== undefined
        ? autoMergeRaw === '1' || autoMergeRaw.toLowerCase() === 'true'
        : config.github.autoMerge,
  }
}

export function isGithubReady(): boolean {
  const g = getGithubConfig()
  return Boolean(g.appId && g.privateKey && g.installationId && g.repoOwner)
}
