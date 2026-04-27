/**
 * Submission routes. v1 implements the manual `.beammod` flow end-to-end as
 * proof of the pipeline; netbeammod variants are stubbed with the same
 * contract but mark themselves "not yet implemented" until that PR lands.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { db, type SubmissionRow } from '../db.js'
import { audit } from '../audit.js'
import { requireAuth, requireVerifiedAuth } from '../auth/plugin.js'
import { canSubmit, claimIfUnowned, getOwner } from './ownership.js'
import { validateBeammod, validateNetbeammod } from './validate.js'
import { downloadAndHash, probeUrl } from './probe.js'
import { runPipeline } from './pipeline.js'
import { inspectZip } from './inspect.js'
import { getRegistry } from '../registry/index.js'

const ID_RE = /^[A-Za-z0-9_-]{2,128}$/

const ManualSchema = z.object({
  identifier: z.string().regex(ID_RE),
  version: z.string().min(1).max(64),
  payload: z.record(z.unknown()),
  // If true, server fetches the URL and computes SHA256 / size, overriding
  // any client-provided values. Recommended.
  hash_server_side: z.boolean().default(true),
})

function publicSubmission(s: SubmissionRow) {
  return {
    id: s.id,
    kind: s.kind,
    identifier: s.identifier,
    version: s.version,
    status: s.status,
    pr_url: s.pr_url,
    error: s.error,
    created_at: s.created_at,
    decided_at: s.decided_at,
  }
}

export async function submissionRoutes(app: FastifyInstance): Promise<void> {
  // List the current user's submissions (dashboard).
  app.get('/mine', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const rows = db
      .prepare<[number], SubmissionRow>(
        `SELECT * FROM submissions WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`
      )
      .all(ctx.user.id)
    return { submissions: rows.map(publicSubmission) }
  })

  // Detail view of one of the user's own submissions, including the full
  // payload they submitted plus any reviewer note. Owner-scoped: an admin
  // can see everyone's submission via /admin/submissions/:id, but a regular
  // user can only see their own here.
  app.get('/mine/:id', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'invalid_input' })
    const row = db
      .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
      .get(id)
    if (!row || row.user_id !== ctx.user.id) {
      return reply.code(404).send({ error: 'not_found' })
    }
    let payload: unknown = null
    try { payload = JSON.parse(row.payload_json) } catch { payload = null }
    return {
      submission: {
        ...publicSubmission(row),
        branch: row.branch,
        review_note: row.review_note,
        payload,
      },
    }
  })

  // Probe a download URL — fast HEAD check the form can call before submit.
  app.post('/probe-url', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const body = z.object({ url: z.string().url() }).safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_input' })
    try {
      const probe = await probeUrl(body.data.url)
      return probe
    } catch (err) {
      return reply.code(502).send({ error: 'probe_failed', message: (err as Error).message })
    }
  })

  // ─── Auto-detect from URL ─────────────────────────────────────────────────
  // Downloads the zip, hashes it, parses the central directory, and returns
  // BeamNG-aware suggestions for the form.
  app.post('/inspect-url', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const body = z.object({ url: z.string().url() }).safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_input' })

    const dir = mkdtempSync(join(tmpdir(), 'inspect-'))
    const filePath = join(dir, 'mod.zip')
    try {
      const probe = await probeUrl(body.data.url)
      if (!probe.ok) {
        return reply.code(400).send({ error: 'download_unreachable', status: probe.status })
      }
      const ctrl = new AbortController()
      const res = await fetch(body.data.url, { redirect: 'follow', signal: ctrl.signal })
      if (!res.ok || !res.body) {
        return reply.code(502).send({ error: 'download_failed', status: res.status })
      }
      // Convert Web ReadableStream → Node Readable for pipeline().
      const { Readable } = await import('node:stream')
      await pipeline(
        Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
        createWriteStream(filePath)
      )
      const result = await inspectZip(filePath)
      return result
    } catch (err) {
      return reply.code(500).send({ error: 'inspect_failed', message: (err as Error).message })
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  // ─── Auto-detect from file upload ─────────────────────────────────────────
  // Accepts a multipart upload of a .zip file (max 2 GiB by server config).
  app.post('/inspect-upload', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: 'multipart_required' })
    }
    const file = await request.file()
    if (!file) return reply.code(400).send({ error: 'no_file' })

    const dir = mkdtempSync(join(tmpdir(), 'inspect-'))
    const filePath = join(dir, 'mod.zip')
    try {
      await pipeline(file.file, createWriteStream(filePath))
      if (file.file.truncated) {
        return reply.code(413).send({ error: 'file_too_large' })
      }
      const result = await inspectZip(filePath)
      return result
    } catch (err) {
      return reply.code(500).send({ error: 'inspect_failed', message: (err as Error).message })
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  // Manual .beammod submission — the proof-of-pipeline flow.
  app.post('/manual', async (request, reply) => {
    const ctx = requireVerifiedAuth(request, reply)
    if (!ctx) return
    const parsed = ManualSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues })
    }
    const { identifier, version, payload, hash_server_side } = parsed.data
    const isAdmin = ctx.user.role === 'admin'

    // Identifier consistency.
    if (typeof payload.identifier !== 'string' || payload.identifier !== identifier) {
      return reply.code(400).send({ error: 'identifier_mismatch' })
    }
    if (typeof payload.version !== 'string' || payload.version !== version) {
      return reply.code(400).send({ error: 'version_mismatch' })
    }

    // Ownership.
    if (!canSubmit(identifier, ctx.user.id, isAdmin)) {
      return reply.code(403).send({ error: 'identifier_owned_by_other_user' })
    }

    // Server-side hash (only for kind=package with a download URL).
    const downloadField = (payload as { download?: string | string[] }).download
    if (hash_server_side && downloadField) {
      const url = Array.isArray(downloadField) ? downloadField[0] : downloadField
      if (typeof url !== 'string') {
        return reply.code(400).send({ error: 'invalid_download_url' })
      }
      try {
        const probe = await probeUrl(url)
        if (!probe.ok) {
          return reply.code(400).send({ error: 'download_unreachable', status: probe.status })
        }
        const { sha256, size } = await downloadAndHash(url)
        ;(payload as Record<string, unknown>).download_hash = { sha256 }
        ;(payload as Record<string, unknown>).download_size = size
      } catch (err) {
        return reply.code(400).send({ error: 'hash_failed', message: (err as Error).message })
      }
    }

    // Schema validation.
    const v = validateBeammod(payload)
    if (!v.valid) {
      return reply.code(400).send({ error: 'schema_invalid', issues: v.errors })
    }

    // Decide trust-tier branch.
    // Special case: if the identifier already exists in the on-disk
    // registry but has no DB owner (i.e. it was auto-scraped or imported
    // before this user account existed), the submitter is implicitly
    // claiming authorship. Always route those through admin review,
    // regardless of trust tier, so a human can verify the claim.
    let status: 'queued' | 'pending_review' =
      ctx.user.trust === 'green' || isAdmin ? 'queued' : 'pending_review'
    const ownerId = getOwner(identifier)
    if (!isAdmin && ownerId === null) {
      try {
        const reg = await getRegistry()
        if (reg.byId.has(identifier)) {
          status = 'pending_review'
        }
      } catch {
        /* registry index optional in dev; fall through */
      }
    }

    const result = db
      .prepare(
        `INSERT INTO submissions
           (user_id, kind, identifier, version, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(ctx.user.id, 'manual_beammod', identifier, version, JSON.stringify(payload), status, Date.now())
    const id = Number(result.lastInsertRowid)

    audit({
      actorId: ctx.user.id,
      action: 'submission.created',
      target: `submission:${id}`,
      details: { kind: 'manual_beammod', identifier, version, status },
    })

    // If owned by no one, claim now (so duplicate submissions while pending
    // can't race). Ownership is harmless if the PR is later rejected — the
    // claim only governs *who can submit further versions*.
    if (getOwner(identifier) === null) {
      claimIfUnowned(identifier, ctx.user.id)
    }

    if (status === 'queued') {
      // Fire-and-forget; status is observable via /mine.
      runPipeline(id).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[pipeline] error', err)
      })
    }

    const row = db
      .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
      .get(id)!
    return { submission: publicSubmission(row) }
  })

  // Resubmit a submission that an admin pushed back with `changes_requested`.
  // Replaces the payload+version on the same row and moves it back to
  // `pending_review` so the same review thread (and reviewer note history)
  // is preserved instead of fragmenting into a new row.
  app.post('/mine/:id/resubmit', async (request, reply) => {
    const ctx = requireVerifiedAuth(request, reply)
    if (!ctx) return
    const subId = Number((request.params as { id: string }).id)
    if (!subId) return reply.code(400).send({ error: 'invalid_input' })
    const parsed = ManualSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues })
    }
    const { identifier, version, payload, hash_server_side } = parsed.data

    const existing = db
      .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
      .get(subId)
    if (!existing || existing.user_id !== ctx.user.id) {
      return reply.code(404).send({ error: 'not_found' })
    }
    if (existing.status !== 'changes_requested') {
      return reply.code(409).send({ error: 'wrong_status', status: existing.status })
    }
    // Lock the identifier — a user mustn't pivot a resubmission to another
    // mod's identifier mid-review.
    if (identifier !== existing.identifier) {
      return reply.code(400).send({ error: 'identifier_mismatch' })
    }
    if (typeof payload.identifier !== 'string' || payload.identifier !== identifier) {
      return reply.code(400).send({ error: 'identifier_mismatch' })
    }
    if (typeof payload.version !== 'string' || payload.version !== version) {
      return reply.code(400).send({ error: 'version_mismatch' })
    }

    // Server-side hash (same logic as /manual).
    const downloadField = (payload as { download?: string | string[] }).download
    if (hash_server_side && downloadField) {
      const url = Array.isArray(downloadField) ? downloadField[0] : downloadField
      if (typeof url !== 'string') {
        return reply.code(400).send({ error: 'invalid_download_url' })
      }
      try {
        const probe = await probeUrl(url)
        if (!probe.ok) {
          return reply.code(400).send({ error: 'download_unreachable', status: probe.status })
        }
        const { sha256, size } = await downloadAndHash(url)
        ;(payload as Record<string, unknown>).download_hash = { sha256 }
        ;(payload as Record<string, unknown>).download_size = size
      } catch (err) {
        return reply.code(400).send({ error: 'hash_failed', message: (err as Error).message })
      }
    }

    const v = validateBeammod(payload)
    if (!v.valid) {
      return reply.code(400).send({ error: 'schema_invalid', issues: v.errors })
    }

    // Preserve `review_note` so the user can still see what was originally
    // requested while the admin re-reviews. The admin's next decision will
    // overwrite it.
    db.prepare(
      `UPDATE submissions
         SET version = ?, payload_json = ?, status = 'pending_review'
       WHERE id = ?`
    ).run(version, JSON.stringify(payload), subId)

    audit({
      actorId: ctx.user.id,
      action: 'submission.resubmitted',
      target: `submission:${subId}`,
      details: { version },
    })

    const row = db
      .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
      .get(subId)!
    return { submission: publicSubmission(row) }
  })

  // ─── Stubs for the remaining flows (return 501 until implemented) ─────────
  for (const path of ['/netbeammod-github', '/netbeammod-beamng', '/claim', '/new-version']) {
    app.post(path, async (request, reply) => {
      const ctx = requireVerifiedAuth(request, reply)
      if (!ctx) return
      // Validate the obvious shape so we don't accept garbage early.
      const body = request.body as { identifier?: unknown; payload?: unknown } | null
      if (!body || typeof body !== 'object') {
        return reply.code(400).send({ error: 'invalid_input' })
      }
      // Schema check for netbeammod variants when payload is provided.
      if (path.startsWith('/netbeammod') && body.payload) {
        const v = validateNetbeammod(body.payload)
        if (!v.valid) return reply.code(400).send({ error: 'schema_invalid', issues: v.errors })
      }
      return reply.code(501).send({
        error: 'not_implemented',
        message: `${path} will be implemented in a follow-up change.`,
      })
    })
  }
}
