/**
 * Centralized config loaded from process.env. Fails fast on missing required
 * values in production; tolerates absent GitHub App config in development so
 * the rest of the app remains testable.
 */
import { readFileSync, existsSync } from 'node:fs'

function env(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v !== undefined && v !== '') return v
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required environment variable: ${name}`)
}

function envOptional(name: string): string | undefined {
  const v = process.env[name]
  return v !== undefined && v !== '' ? v : undefined
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return v === '1' || v.toLowerCase() === 'true'
}

const NODE_ENV = env('NODE_ENV', 'development')
const isProd = NODE_ENV === 'production'

const githubPrivateKeyPath = envOptional('GITHUB_APP_PRIVATE_KEY_PATH')
const githubPrivateKey =
  githubPrivateKeyPath && existsSync(githubPrivateKeyPath)
    ? readFileSync(githubPrivateKeyPath, 'utf-8')
    : undefined

export const config = {
  nodeEnv: NODE_ENV,
  isProd,
  port: Number(env('PORT', '8080')),
  host: env('HOST', '0.0.0.0'),
  publicOrigin: env('PUBLIC_ORIGIN', 'http://localhost:8080'),
  trustProxy: env('TRUST_PROXY', '127.0.0.1,::1')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  sessionSecret: env(
    'SESSION_SECRET',
    isProd ? undefined : 'dev-secret-change-me-dev-secret-change-me-32b'
  ),
  cookieSecure: envBool('COOKIE_SECURE', isProd),

  databasePath: env('DATABASE_PATH', isProd ? '/data/registry-web.db' : './data/dev.db'),

  github: {
    appId: envOptional('GITHUB_APP_ID'),
    privateKey: githubPrivateKey,
    installationId: envOptional('GITHUB_APP_INSTALLATION_ID'),
    repoOwner: envOptional('GITHUB_REPO_OWNER'),
    repoName: env('GITHUB_REPO_NAME', 'BeamNG-Mod-Registry'),
    defaultBranch: env('GITHUB_DEFAULT_BRANCH', 'main'),
    autoMerge: envBool('GITHUB_AUTO_MERGE', true),
  },

  repoWorkdir: env('REPO_WORKDIR', isProd ? '/data/repo' : './data/repo'),

  // Directory containing one folder per mod, each holding `*.beammod` files.
  // Used when `registrySource` is `local` or as a fallback when `auto` and
  // the remote fetch fails. In production this is the cloned registry under
  // `${repoWorkdir}/mods`. In development we point at the workspace's local
  // `mods/` (cwd is `web/backend/` when `tsx watch` runs, so `../../mods`
  // reaches the repo root).
  modsRoot: env(
    'MODS_ROOT',
    isProd ? (env('REPO_WORKDIR', '/data/repo') + '/mods') : '../../mods'
  ),

  // Where the registry browser pulls mod metadata from.
  //   `auto`   — try remote first, fall back to local on failure (default)
  //   `remote` — only use the published GitHub Releases index
  //   `local`  — only use the local `modsRoot` directory
  registrySource: (env('REGISTRY_SOURCE', 'auto') as 'auto' | 'remote' | 'local'),
  // URL to the published `registry-index.json`. Defaults to the
  // `latest` release asset from the configured GitHub repo. Override to
  // pin a different repo or a self-hosted mirror.
  registryIndexUrl: env(
    'REGISTRY_INDEX_URL',
    `https://github.com/${envOptional('GITHUB_REPO_OWNER') ?? 'BeamMP'}/${env('GITHUB_REPO_NAME', 'BeamNG-Mod-Registry')}/releases/latest/download/registry-index.json`
  ),
  // How often to re-fetch the remote registry index (milliseconds).
  registryRefreshMs: Number(env('REGISTRY_REFRESH_MS', String(5 * 60_000))),

  bootstrapAdminEmail: envOptional('BOOTSTRAP_ADMIN_EMAIL')?.toLowerCase(),

  // Public-abuse hardening. Defaults are conservative for a public deploy.
  submitMaxUploadBytes: Number(env('SUBMIT_MAX_UPLOAD_BYTES', String(500 * 1024 * 1024))),

  // Cloudflare Turnstile. Both keys must be present to enable; otherwise the
  // captcha is skipped (useful for private/dev deployments).
  turnstile: {
    siteKey: envOptional('TURNSTILE_SITE_KEY'),
    secretKey: envOptional('TURNSTILE_SECRET_KEY'),
  },

  // Email / verification. If `smtpHost` is unset, verification mail is not
  // sent and `emailVerificationRequired` is implicitly false even if set.
  email: {
    smtpHost: envOptional('SMTP_HOST'),
    smtpPort: Number(env('SMTP_PORT', '587')),
    smtpUser: envOptional('SMTP_USER'),
    smtpPass: envOptional('SMTP_PASS'),
    smtpSecure: envBool('SMTP_SECURE', false),
    from: env('SMTP_FROM', 'registry@example.com'),
    verificationRequired: envBool('EMAIL_VERIFICATION_REQUIRED', false),
  },
} as const

export function isGithubConfigured(): boolean {
  const g = config.github
  return Boolean(g.appId && g.privateKey && g.installationId && g.repoOwner)
}

export function isTurnstileConfigured(): boolean {
  return Boolean(config.turnstile.siteKey && config.turnstile.secretKey)
}

export function isSmtpConfigured(): boolean {
  return Boolean(config.email.smtpHost)
}

/**
 * Fail-fast boot check for production deployments. Refuses to start if any
 * of the obvious foot-guns are present — weak/default session secret, dev
 * fallback values left in place, etc. Logs to stderr and throws so the
 * container exits and Unraid surfaces the error.
 */
export function assertProductionReady(): void {
  if (!isProd) return
  const fatal: string[] = []
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    fatal.push('SESSION_SECRET must be set and >=32 chars in production')
  }
  if (/dev-secret-change-me/i.test(config.sessionSecret)) {
    fatal.push('SESSION_SECRET still contains the development placeholder')
  }
  if (config.publicOrigin.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(config.publicOrigin)) {
    fatal.push('PUBLIC_ORIGIN must use https:// for a public deployment')
  }
  if (!config.cookieSecure) {
    fatal.push('COOKIE_SECURE=true is required in production (must be served over HTTPS via reverse proxy)')
  }
  if (config.email.verificationRequired && !isSmtpConfigured()) {
    fatal.push('EMAIL_VERIFICATION_REQUIRED=true but no SMTP_HOST configured')
  }
  if (fatal.length > 0) {
    // eslint-disable-next-line no-console
    console.error('\n[boot] Refusing to start — production config issues:')
    for (const m of fatal) console.error('  - ' + m)
    throw new Error('production_config_invalid')
  }
}
