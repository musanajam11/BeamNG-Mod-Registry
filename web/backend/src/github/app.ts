/**
 * GitHub App authentication and per-installation Octokit factory.
 *
 * The container holds the App's private key (mounted secret OR DB-stored
 * via the admin Settings page). On demand we mint an installation access
 * token (cached for ~50 min) and return an Octokit instance scoped to the
 * registry repository's installation.
 */
import { App } from '@octokit/app'
import { Octokit } from '@octokit/rest'
import { getGithubConfig, isGithubReady } from '../settings.js'

interface CachedApp {
  app: App
  // Identity used to build the App, so we can invalidate when settings change.
  appId: string
  privateKeyHash: string
}

let cachedApp: CachedApp | null = null
let cachedOctokit: { value: Octokit; expiresAt: number; appId: string } | null = null

function quickHash(s: string): string {
  // Cheap fingerprint to detect when admins rotate the private key. Not for
  // security — just for cache invalidation.
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return String(h)
}

function getApp(): App {
  if (!isGithubReady()) {
    throw new Error('GitHub App is not configured')
  }
  const g = getGithubConfig()
  const pkHash = quickHash(g.privateKey!)
  if (
    !cachedApp ||
    cachedApp.appId !== g.appId ||
    cachedApp.privateKeyHash !== pkHash
  ) {
    cachedApp = {
      app: new App({ appId: g.appId!, privateKey: g.privateKey! }),
      appId: g.appId!,
      privateKeyHash: pkHash,
    }
    cachedOctokit = null
  }
  return cachedApp.app
}

export async function getInstallationOctokit(): Promise<Octokit> {
  const g = getGithubConfig()
  if (
    cachedOctokit &&
    cachedOctokit.appId === g.appId &&
    cachedOctokit.expiresAt > Date.now() + 60_000
  ) {
    return cachedOctokit.value
  }
  // Mint an installation token via the App, then build a *real* @octokit/rest
  // Octokit so the `.repos`, `.pulls`, `.git`, etc. namespaces are attached.
  // (`app.getInstallationOctokit()` returns a bare @octokit/core instance.)
  const token = await getInstallationToken()
  const octokit = new Octokit({ auth: token })
  cachedOctokit = {
    value: octokit,
    expiresAt: Date.now() + 50 * 60 * 1000,
    appId: g.appId!,
  }
  return octokit
}

export async function getInstallationToken(): Promise<string> {
  const app = getApp()
  const g = getGithubConfig()
  const installationId = Number(g.installationId)
  const { token } = await (app.octokit as unknown as {
    auth: (opts: unknown) => Promise<{ token: string }>
  }).auth({ type: 'installation', installationId })
  return token
}

/** Force the next call to rebuild the App + token. Call after settings change. */
export function invalidateGithubCache(): void {
  cachedApp = null
  cachedOctokit = null
}

