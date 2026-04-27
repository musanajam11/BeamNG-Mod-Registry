/**
 * Local working clone of the registry repository.
 *
 * Uses the GitHub App's installation token for `git push` (no SSH keys, no
 * personal credentials). The clone lives at REPO_WORKDIR and is reused
 * across requests; a process-wide mutex serializes access so concurrent
 * submissions never trample each other's branches.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import simpleGit, { type SimpleGit } from 'simple-git'
import { config } from '../config.js'
import { getGithubConfig } from '../settings.js'
import { getInstallationToken } from './app.js'

const BOT_NAME = 'registry-bot'
const BOT_EMAIL = 'registry-bot@users.noreply.github.com'

let mutex: Promise<unknown> = Promise.resolve()

/** Serialize all repo operations through a single in-process mutex. */
export async function withRepoLock<T>(fn: (git: SimpleGit) => Promise<T>): Promise<T> {
  const next = mutex.then(async () => {
    const git = await ensureClone()
    return fn(git)
  })
  // Keep the chain alive even when fn throws.
  mutex = next.catch(() => undefined)
  return next
}

async function ensureClone(): Promise<SimpleGit> {
  const g = getGithubConfig()
  mkdirSync(dirname(config.repoWorkdir), { recursive: true })
  if (!existsSync(config.repoWorkdir + '/.git')) {
    const token = await getInstallationToken()
    const url = `https://x-access-token:${token}@github.com/${g.repoOwner}/${g.repoName}.git`
    mkdirSync(config.repoWorkdir, { recursive: true })
    const tmp = simpleGit()
    await tmp.clone(url, config.repoWorkdir, ['--depth', '50'])
  }
  const git = simpleGit(config.repoWorkdir)
  await git.addConfig('user.name', BOT_NAME)
  await git.addConfig('user.email', BOT_EMAIL)
  // Refresh remote URL each time so the token never goes stale.
  const token = await getInstallationToken()
  const url = `https://x-access-token:${token}@github.com/${g.repoOwner}/${g.repoName}.git`
  await git.remote(['set-url', 'origin', url])
  await git.fetch('origin', g.defaultBranch)
  await git.checkout(g.defaultBranch)
  await git.reset(['--hard', `origin/${g.defaultBranch}`])
  return git
}
