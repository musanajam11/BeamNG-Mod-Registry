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

// ─── Cloudflare Turnstile ───────────────────────────────────────────────
// DB-backed override of TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY env vars.

export const TURNSTILE_KEYS = {
  siteKey: 'turnstile.site_key',
  secretKey: 'turnstile.secret_key',
} as const

export interface ResolvedTurnstileConfig {
  siteKey?: string
  secretKey?: string
}

export function getTurnstileConfig(): ResolvedTurnstileConfig {
  const m = getMap()
  return {
    siteKey: m.get(TURNSTILE_KEYS.siteKey) ?? config.turnstile.siteKey,
    secretKey: m.get(TURNSTILE_KEYS.secretKey) ?? config.turnstile.secretKey,
  }
}

export function isTurnstileReady(): boolean {
  const t = getTurnstileConfig()
  return Boolean(t.siteKey && t.secretKey)
}

// ─── Theme / appearance ─────────────────────────────────────────────────
// Admin-controlled visual customisation persisted in the settings table and
// served unauthenticated via /api/theme so it can be applied before login.

export const THEME_KEYS = {
  backgroundUrl: 'theme.background_url',
  backgroundBlurPx: 'theme.background_blur_px',
  backgroundDimPct: 'theme.background_dim_pct',
  primaryColor: 'theme.primary_color',
  colorScheme: 'theme.color_scheme', // 'auto' | 'light' | 'dark'
  appName: 'theme.app_name',
  applyToAuthOnly: 'theme.apply_to_auth_only', // '0' | '1'
} as const

export interface ResolvedTheme {
  background_url: string
  background_blur_px: number
  background_dim_pct: number
  primary_color: string
  color_scheme: 'auto' | 'light' | 'dark'
  app_name: string
  apply_to_auth_only: boolean
}

const THEME_DEFAULTS: ResolvedTheme = {
  background_url: 'https://images6.alphacoders.com/134/thumb-1920-1340333.jpeg',
  background_blur_px: 14,
  background_dim_pct: 45,
  primary_color: 'blue',
  color_scheme: 'auto',
  app_name: 'BeamNG Mod Registry',
  apply_to_auth_only: false,
}

function clampNum(v: string | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export function getTheme(): ResolvedTheme {
  const m = getMap()
  const get = (k: string) => m.get(k)
  const scheme = get(THEME_KEYS.colorScheme)
  return {
    background_url: get(THEME_KEYS.backgroundUrl) ?? THEME_DEFAULTS.background_url,
    background_blur_px: clampNum(get(THEME_KEYS.backgroundBlurPx), 0, 60, THEME_DEFAULTS.background_blur_px),
    background_dim_pct: clampNum(get(THEME_KEYS.backgroundDimPct), 0, 90, THEME_DEFAULTS.background_dim_pct),
    primary_color: get(THEME_KEYS.primaryColor) ?? THEME_DEFAULTS.primary_color,
    color_scheme:
      scheme === 'light' || scheme === 'dark' || scheme === 'auto'
        ? scheme
        : THEME_DEFAULTS.color_scheme,
    app_name: get(THEME_KEYS.appName) ?? THEME_DEFAULTS.app_name,
    apply_to_auth_only: get(THEME_KEYS.applyToAuthOnly) === '1',
  }
}
