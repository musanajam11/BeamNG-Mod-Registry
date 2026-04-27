/**
 * Polls GitHub for the merge state of submissions whose PRs are open.
 *
 * The pipeline only marks a submission as `pr_opened` after pushing a branch
 * and creating a PR — it never sees the actual merge. Without this poller,
 * submissions stay `pr_opened` forever and contribution attribution
 * (last-edited / history dropdown) only kicks in if an admin manually
 * flips the row to `merged` in the DB.
 *
 * We poll every POLL_INTERVAL_MS, fetch the PR via the installation token,
 * and:
 *   - merged === true                      -> status = 'merged'
 *   - state === 'closed' && !merged        -> status = 'rejected' (PR closed unmerged)
 *   - otherwise                            -> leave as 'pr_opened'
 */
import { db } from '../db.js'
import { audit } from '../audit.js'
import { getInstallationOctokit } from '../github/app.js'
import { getGithubConfig } from '../settings.js'

const POLL_INTERVAL_MS = 60_000

interface OpenPrRow {
  id: number
  pr_url: string | null
}

function parsePrNumber(url: string | null): number | null {
  if (!url) return null
  const m = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  return m ? Number(m[1]) : null
}

async function pollOnce(): Promise<void> {
  const g = getGithubConfig()
  if (!g.appId || !g.privateKey || !g.installationId || !g.repoOwner) return

  const rows = db
    .prepare(`SELECT id, pr_url FROM submissions WHERE status = 'pr_opened' AND pr_url IS NOT NULL`)
    .all() as OpenPrRow[]
  if (rows.length === 0) return

  let octokit: Awaited<ReturnType<typeof getInstallationOctokit>>
  try {
    octokit = await getInstallationOctokit()
  } catch (err) {
    // GitHub App not reachable right now — try again next tick.
    console.warn('[merge-poller] getInstallationOctokit failed:', err instanceof Error ? err.message : err)
    return
  }

  for (const row of rows) {
    const prNumber = parsePrNumber(row.pr_url)
    if (!prNumber) {
      console.warn('[merge-poller] could not parse PR number from', row.pr_url)
      continue
    }
    try {
      const { data: pr } = await octokit.pulls.get({
        owner: g.repoOwner!,
        repo: g.repoName,
        pull_number: prNumber,
      })
      console.log(`[merge-poller] submission ${row.id} PR #${prNumber}: state=${pr.state} merged=${pr.merged}`)
      if (pr.merged) {
        const decidedAt = pr.merged_at ? Date.parse(pr.merged_at) : Date.now()
        db.prepare(
          `UPDATE submissions
              SET status = 'merged', decided_at = ?
            WHERE id = ? AND status = 'pr_opened'`
        ).run(decidedAt, row.id)
        audit({
          actorId: null,
          action: 'pipeline.merged',
          target: `submission:${row.id}`,
          details: { pr: prNumber, mergedAt: decidedAt },
        })
      } else if (pr.state === 'closed') {
        db.prepare(
          `UPDATE submissions
              SET status = 'rejected', decided_at = ?, error = COALESCE(error, ?)
            WHERE id = ? AND status = 'pr_opened'`
        ).run(Date.now(), 'Pull request was closed without merging.', row.id)
        audit({
          actorId: null,
          action: 'pipeline.pr_closed',
          target: `submission:${row.id}`,
          details: { pr: prNumber },
        })
      }
    } catch (err) {
      // Network blip or PR temporarily missing — retry next interval.
      console.warn(`[merge-poller] pulls.get failed for submission ${row.id} PR #${prNumber}:`, err instanceof Error ? err.message : err)
    }
  }
}

let timer: NodeJS.Timeout | null = null

export function startMergePoller(): void {
  if (timer) return
  console.log(`[merge-poller] starting; interval=${POLL_INTERVAL_MS}ms`)
  // Kick off one poll on startup so dashboards refresh promptly after a deploy.
  void pollOnce()
  timer = setInterval(() => {
    void pollOnce()
  }, POLL_INTERVAL_MS).unref()
}

export function stopMergePoller(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
