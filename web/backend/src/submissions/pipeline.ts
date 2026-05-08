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
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
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

      // ─── Deletion: remove mods/<id>/ and netbeammod/<id>.netbeammod ────
      // Handled inline before the metadata-merge plumbing below, since the
      // delete flow has none of the .beammod/template propagation logic.
      if (sub.kind === 'delete') {
        return runDelete(git, sub, payload)
      }

      // All submissions made through the authenticated web UI go through
      // admin/auto review and CI download verification, so they earn the
      // x_verified blue check by definition. (The inflator separately sets
      // this for github-sourced auto-generated entries.)
      payload.x_verified = true

      // Watch-source hints set by the manual submit form. We promote these
      // into a netbeammod template so the inflator picks up future releases
      // automatically. They're stripped from the version .beammod (purely
      // internal hints, not metadata).
      const watchKref = typeof payload.x_watch_kref === 'string' ? payload.x_watch_kref : null
      const watchFilter = typeof payload.x_watch_filter_asset === 'string' ? payload.x_watch_filter_asset : null
      delete payload.x_watch_kref
      delete payload.x_watch_filter_asset

      // Peek at the netbeammod template (if any) so we can also propagate
      // metadata back into it below.
      let existingTmpl: Record<string, unknown> | null = null
      const tmplRel = `netbeammod/${sub.identifier}.netbeammod`
      const tmplAbs = join(config.repoWorkdir, tmplRel)
      if (existsSync(tmplAbs)) {
        try {
          existingTmpl = JSON.parse(readFileSync(tmplAbs, 'utf-8')) as Record<string, unknown>
        } catch {
          existingTmpl = null
        }
      }

      const { relPath, content, commitMessage, prTitle, prBody } = renderFiles(sub, payload)

      const absPath = join(config.repoWorkdir, relPath)
      mkdirSync(join(absPath, '..'), { recursive: true })
      writeFileSync(absPath, content)

      const stagedPaths: string[] = [relPath]
      let templateUpdated = false
      let templateCreated = false

      // If this submission targets a mod that already has a netbeammod
      // template, also update the template so future inflator runs inherit
      // the new metadata (thumbnail, description, tags, etc.). Without this
      // a manual edit to a single version is silently overwritten the next
      // time the inflator generates a new .beammod from the template.
      if ((sub.kind === 'manual_beammod' || sub.kind === 'new_version') && existingTmpl) {
        const merged = mergeIntoTemplate(existingTmpl, payload)
        // Update template directives if the user changed them via the watch fields.
        if (watchKref) merged.$kref = watchKref
        if (watchFilter) merged.$filter_asset = watchFilter
        const newTmpl = JSON.stringify(merged, null, 2) + '\n'
        const oldTmpl = JSON.stringify(existingTmpl, null, 2) + '\n'
        if (newTmpl !== oldTmpl) {
          writeFileSync(tmplAbs, newTmpl)
          stagedPaths.push(tmplRel)
          templateUpdated = true
        }
      } else if (
        (sub.kind === 'manual_beammod' || sub.kind === 'new_version') &&
        !existingTmpl &&
        watchKref
      ) {
        // No existing template, but the user opted in to upstream watching.
        // Generate a fresh template seeded from the curated metadata.
        const newTmplObj = mergeIntoTemplate({}, payload)
        newTmplObj.$kref = watchKref
        if (watchFilter) newTmplObj.$filter_asset = watchFilter
        // Default to a sensible release window so the first inflator run
        // doesn't try to backfill years of history.
        newTmplObj.$max_releases = 10
        const newTmpl = JSON.stringify(newTmplObj, null, 2) + '\n'
        mkdirSync(join(tmplAbs, '..'), { recursive: true })
        writeFileSync(tmplAbs, newTmpl)
        stagedPaths.push(tmplRel)
        templateCreated = true
      }

      const branch = `submission/${sub.kind}/${sub.identifier}/${Date.now()}`
      await git.checkoutLocalBranch(branch)
      for (const p of stagedPaths) await git.add(p)

      // Short-circuit no-op submissions before we ever talk to GitHub.
      // If `git status --porcelain` is empty after staging, the payload is
      // byte-for-byte identical to what's already on `main`, and pushing
      // would produce an empty PR ("No commits between main and …").
      const status = await git.status()
      if (status.files.length === 0) {
        throw new Error(
          'No changes detected: the submitted .beammod is identical to the version already in the registry. ' +
            'Edit at least one field (or bump the version) before resubmitting.'
        )
      }

      const tmplNote = templateCreated
        ? `\n\nAlso creates netbeammod/${sub.identifier}.netbeammod so the inflator will pick up future releases automatically.`
        : templateUpdated
          ? `\n\nAlso updates netbeammod/${sub.identifier}.netbeammod so future inflator runs inherit the new metadata.`
          : ''
      await git.commit(`${commitMessage}${tmplNote}`)
      await git.push('origin', branch, ['--set-upstream'])

      const tmplBodyNote = templateCreated
        ? `\n\n_Also creates \`netbeammod/${sub.identifier}.netbeammod\` — the inflator will auto-publish future releases from \`${watchKref}\`._`
        : templateUpdated
          ? `\n\n_Also updates \`netbeammod/${sub.identifier}.netbeammod\` so future inflator-generated versions inherit this metadata._`
          : ''
      const pr = await openPullRequest({ branch, title: prTitle, body: `${prBody}${tmplBodyNote}` })
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
    const raw = err instanceof Error ? err.message : String(err)
    // Translate GitHub's opaque "No commits between …" 422 into a message
    // a submitter can act on. This happens when the branch we just pushed
    // is identical to main — usually because the in-flight submission was
    // created before the no-op guard above, or because the branch was
    // pushed but `git commit` produced an empty commit on a quirky tree.
    const msg = /No commits between/i.test(raw)
      ? 'GitHub rejected the pull request because the submitted content is identical to what already exists in the registry. Edit at least one field (or bump the version) and resubmit.'
      : raw
    updateSubmission.run('failed', null, null, msg, Date.now(), submissionId)
    audit({
      actorId: null,
      action: 'pipeline.failed',
      target: `submission:${submissionId}`,
      details: { error: msg, raw: msg === raw ? undefined : raw },
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
    case 'delete':
      // Deletion is handled by `runDelete` (below); renderFiles isn't
      // called for delete submissions, but TS needs an exhaustive switch.
      throw new Error('renderFiles: delete handled separately by runDelete')
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

/**
 * Delete-mod pipeline branch. Removes both the per-version `.beammod`
 * directory (`mods/<id>/`) and the optional netbeammod template
 * (`netbeammod/<id>.netbeammod`) so the inflator doesn't immediately
 * regenerate the entries. Either path being absent is fine \u2014 we still
 * proceed if at least one was actually removed.
 */
async function runDelete(
  git: import('simple-git').SimpleGit,
  sub: SubmissionRow,
  payload: Record<string, unknown>,
): Promise<{ branch: string; prUrl: string }> {
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : ''
  const requestedBy = typeof payload.requested_by === 'string' ? payload.requested_by : ''
  const isOwnerRequest = payload.is_owner === true

  const modsRel = `mods/${sub.identifier}`
  const tmplRel = `netbeammod/${sub.identifier}.netbeammod`
  const modsAbs = join(config.repoWorkdir, modsRel)
  const tmplAbs = join(config.repoWorkdir, tmplRel)

  const branch = `submission/delete/${sub.identifier}/${Date.now()}`
  await git.checkoutLocalBranch(branch)

  const removedPaths: string[] = []
  if (existsSync(modsAbs)) {
    await git.rm(['-r', modsRel])
    removedPaths.push(modsRel)
  }
  if (existsSync(tmplAbs)) {
    await git.rm([tmplRel])
    removedPaths.push(tmplRel)
  }

  if (removedPaths.length === 0) {
    throw new Error(
      `Nothing to delete: neither mods/${sub.identifier}/ nor netbeammod/${sub.identifier}.netbeammod ` +
        `exist on the default branch. The mod may have already been removed.`
    )
  }

  // Defense in depth: confirm the working tree actually has staged removals
  // before we ever push. Catches the case where `git rm` silently no-ops on
  // an already-clean path.
  const status = await git.status()
  if (status.files.length === 0) {
    throw new Error(`Delete produced no staged changes for ${sub.identifier}.`)
  }

  const requesterLabel = isOwnerRequest
    ? `claimed owner (user #${sub.user_id})`
    : `non-owner request (user #${sub.user_id}${requestedBy ? `, ${requestedBy}` : ''})`
  const reasonLine = reason ? `\n\nReason: ${reason}` : ''
  const commitMessage = `Delete ${sub.identifier}\n\nRequested by ${requesterLabel} via the Registry Web UI.${reasonLine}`
  const prTitle = `Delete ${sub.identifier}`
  const prBody = [
    `Removes \`${sub.identifier}\` from the registry per a Web UI submission.`,
    ``,
    `Removed paths:`,
    ...removedPaths.map((p) => `- \`${p}\``),
    ``,
    `Requested by: ${requesterLabel}.`,
    reason ? `\nReason given by submitter:\n\n> ${reason.replace(/\n/g, '\n> ')}` : '',
    ``,
    prFooter(sub),
  ].join('\n')

  await git.commit(commitMessage)
  await git.push('origin', branch, ['--set-upstream'])
  const pr = await openPullRequest({ branch, title: prTitle, body: prBody })
  return { branch, prUrl: pr.url }
}

// Fields owned by the inflator (computed per-release). Never copy these
// from a version .beammod payload back into the netbeammod template.
// `x_verified` is intentionally NOT here: web-UI submissions set it on the
// template too, so future inflator runs keep the badge (the inflator
// honors `template.x_verified === true` for non-github sources).
const INFLATOR_OWNED_FIELDS = new Set([
  'version',
  'download',
  'download_hash',
  'download_size',
  'release_date',
])

/**
 * Merge metadata fields from a manual .beammod submission into the existing
 * netbeammod template. Preserves all `$`-prefixed directives (kref, filter,
 * max_releases, etc.) from the template and drops version-specific fields
 * the inflator computes itself.
 */
function mergeIntoTemplate(
  template: Record<string, unknown>,
  payload: Record<string, unknown>
): Record<string, unknown> {
  // Start from the template so $-fields and unknown extras stay put.
  const out: Record<string, unknown> = { ...template }
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith('$')) continue
    if (INFLATOR_OWNED_FIELDS.has(key)) continue
    out[key] = value
  }
  return out
}
