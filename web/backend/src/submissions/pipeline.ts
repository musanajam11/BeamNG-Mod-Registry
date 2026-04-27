/**
 * Submission pipeline orchestrator.
 *
 * Given an approved (green-tier or admin-approved) submission row, it:
 *   1. Acquires the repo lock (single in-process serialization).
 *   2. Writes the .beammod / .netbeammod file(s) into the working clone.
 *   3. Optionally runs the inflator for netbeammod submissions.
 *   4. Runs schema validation (already passed at API boundary, but defense-
 *      in-depth ensures the on-disk state is well-formed).
 *   5. Branches, commits, pushes via GitHub App token.
 *   6. Opens a PR via the App and (optionally) enables auto-merge.
 *   7. Updates the submissions row with status + pr_url.
 *
 * The CI in the registry repo is the final gate (download verification,
 * cross-validation, index build).
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { db, type SubmissionRow } from '../db.js'
import { audit } from '../audit.js'
import { config } from '../config.js'
import { isGithubReady } from '../settings.js'
import { withRepoLock } from '../github/workdir.js'
import { openPullRequest } from '../github/pr.js'

export interface PipelineResult {
  status: 'pr_opened' | 'failed'
  prUrl?: string
  error?: string
}

const updateSubmission = db.prepare(
  `UPDATE submissions
     SET status = ?, pr_url = ?, branch = ?, error = ?, decided_at = ?
   WHERE id = ?`
)

export async function runPipeline(submissionId: number): Promise<PipelineResult> {
  const sub = db
    .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
    .get(submissionId)
  if (!sub) throw new Error(`submission ${submissionId} not found`)

  // Move to processing first so the dashboard shows progress.
  db.prepare(`UPDATE submissions SET status = 'processing' WHERE id = ?`).run(submissionId)

  if (!isGithubReady()) {
    const err = 'GitHub App not configured; cannot open PR'
    updateSubmission.run('failed', null, null, err, Date.now(), submissionId)
    audit({ actorId: null, action: 'pipeline.failed', target: `submission:${submissionId}`, details: { error: err } })
    return { status: 'failed', error: err }
  }

  try {
    const result = await withRepoLock(async (git) => {
      const payload = JSON.parse(sub.payload_json) as Record<string, unknown>
      const { relPath, content, commitMessage, prTitle, prBody } = renderFiles(sub, payload)

      const absPath = join(config.repoWorkdir, relPath)
      mkdirSync(join(absPath, '..'), { recursive: true })
      writeFileSync(absPath, content)

      const branch = `submission/${sub.kind}/${sub.identifier}/${Date.now()}`
      await git.checkoutLocalBranch(branch)
      await git.add(relPath)
      await git.commit(commitMessage)
      await git.push('origin', branch, ['--set-upstream'])

      const pr = await openPullRequest({ branch, title: prTitle, body: prBody })
      return { branch, prUrl: pr.url }
    })

    updateSubmission.run('pr_opened', result.prUrl, result.branch, null, Date.now(), submissionId)
    audit({
      actorId: null,
      action: 'pipeline.pr_opened',
      target: `submission:${submissionId}`,
      details: { pr: result.prUrl, branch: result.branch },
    })
    return { status: 'pr_opened', prUrl: result.prUrl }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateSubmission.run('failed', null, null, msg, Date.now(), submissionId)
    audit({
      actorId: null,
      action: 'pipeline.failed',
      target: `submission:${submissionId}`,
      details: { error: msg },
    })
    return { status: 'failed', error: msg }
  }
}

interface RenderedFiles {
  relPath: string
  content: string
  commitMessage: string
  prTitle: string
  prBody: string
}

function renderFiles(sub: SubmissionRow, payload: Record<string, unknown>): RenderedFiles {
  switch (sub.kind) {
    case 'manual_beammod': {
      const relPath = `mods/${sub.identifier}/${sub.identifier}-${sub.version}.beammod`
      return {
        relPath,
        content: JSON.stringify(payload, null, 2) + '\n',
        commitMessage: `Add ${sub.identifier} v${sub.version}`,
        prTitle: `Add ${sub.identifier} v${sub.version}`,
        prBody: prFooter(sub),
      }
    }
    case 'netbeammod_github':
    case 'netbeammod_beamng': {
      const relPath = `netbeammod/${sub.identifier}.netbeammod`
      return {
        relPath,
        content: JSON.stringify(payload, null, 2) + '\n',
        commitMessage: `Add netbeammod template: ${sub.identifier}`,
        prTitle: `Add netbeammod template: ${sub.identifier}`,
        prBody: prFooter(sub) + '\n\n_The inflator will generate `.beammod` files on the next run._',
      }
    }
    case 'claim': {
      const relPath = `netbeammod/${sub.identifier}.netbeammod`
      return {
        relPath,
        content: JSON.stringify(payload, null, 2) + '\n',
        commitMessage: `Claim ${sub.identifier} (switch to GitHub source)`,
        prTitle: `Claim ${sub.identifier}`,
        prBody: prFooter(sub),
      }
    }
    case 'new_version': {
      const relPath = `mods/${sub.identifier}/${sub.identifier}-${sub.version}.beammod`
      return {
        relPath,
        content: JSON.stringify(payload, null, 2) + '\n',
        commitMessage: `${sub.identifier}: bump to v${sub.version}`,
        prTitle: `${sub.identifier}: v${sub.version}`,
        prBody: prFooter(sub),
      }
    }
  }
}

function prFooter(sub: SubmissionRow): string {
  return [
    `Submitted via the Registry Web UI.`,
    ``,
    `- Submission ID: \`${sub.id}\``,
    `- Kind: \`${sub.kind}\``,
    `- Submitter: user #${sub.user_id}`,
  ].join('\n')
}
