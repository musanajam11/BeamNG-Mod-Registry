/**
 * Submission routes. v1 implements the manual `.beammod` flow end-to-end as
 * proof of the pipeline; netbeammod variants are stubbed with the same
 * contract but mark themselves "not yet implemented" until that PR lands.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { db, type SubmissionRow } from '../db.js'
import { audit } from '../audit.js'
import { config } from '../config.js'
import { requireAuth, requireVerifiedAuth } from '../auth/plugin.js'
import { getOwner, listOwnedByUser, releaseOwnership } from './ownership.js'
import { validateBeammod, validateNetbeammod } from './validate.js'
import { downloadAndHash, probeUrl, validateDownloadUrl } from './probe.js'
import { runPipeline } from './pipeline.js'
import { inspectZip } from './inspect.js'
import { lookup as lookupSource, parseLookupUrl } from './lookup.js'
import { findDuplicates } from './duplicateCheck.js'
import {
  emitInspectProgress,
  isValidInspectId,
  subscribeInspect,
  closeInspectChannel,
  type InspectProgressEvent,
} from './progress.js'
import { getRegistry, summarize } from '../registry/index.js'
import { EMPTY_RATING, loadRatings } from './ratings.js'

const ID_RE = /^[A-Za-z0-9_-]{2,128}$/

const ManualSchema = z.object({
  identifier: z.string().regex(ID_RE),
  version: z.string().min(1).max(64),
  payload: z.record(z.unknown()),
  // If true, server fetches the URL and computes SHA256 / size, overriding
  // any client-provided values. Recommended.
  hash_server_side: z.boolean().default(true),
  // Optional upstream-watch hints. When set, the pipeline also creates (or
  // updates) a netbeammod/<id>.netbeammod template so the inflator auto-
  // publishes future releases from this source.
  //   watch_kref: '#/github/owner/repo' or '#/beamng/12345'
  //   watch_filter_asset: optional regex matched against release asset names
  watch_kref: z
    .string()
    .regex(/^#\/(github\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|beamng\/\d+)$/)
    .optional(),
  watch_filter_asset: z.string().min(1).max(256).optional(),
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
    const v = validateDownloadUrl(body.data.url)
    if (!v.ok) return reply.code(400).send({ error: v.reason, message: v.message })
    try {
      const probe = await probeUrl(body.data.url)
      return probe
    } catch (err) {
      return reply.code(502).send({ error: 'probe_failed', message: (err as Error).message })
    }
  })

  // ─── Duplicate check ─────────────────────────────────────────────────────
  // Given any subset of identifying fields the user has filled in so far,
  // return registry entries that look like the same mod. The submit form
  // calls this opportunistically (after lookup/inspect, and on debounced
  // identifier/download edits) so authors can choose to "edit existing"
  // instead of accidentally creating a parallel entry.
  const DupSchema = z.object({
    identifier: z.string().min(1).max(256).optional(),
    download: z.string().min(1).max(2048).optional(),
    repository: z.string().min(1).max(2048).optional(),
    beamng_resource: z.string().min(1).max(2048).optional(),
  })
  app.post('/check-duplicate', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const body = DupSchema.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_input' })
    if (
      !body.data.identifier &&
      !body.data.download &&
      !body.data.repository &&
      !body.data.beamng_resource
    ) {
      return { matches: [] }
    }
    const reg = await getRegistry()
    const matches = findDuplicates(body.data, reg.entries, reg.byId)
    return { matches }
  })

  // ─── Mod Lookup ──────────────────────────────────────────────────────────
  // Alternative to uploading a zip: given a public source URL (GitHub repo
  // or BeamNG.com resource page), fetch rich metadata (name, author,
  // license, description, latest release/version, tags, thumbnail, …) so
  // the form can be pre-populated. Hits live external services so it's
  // rate-limited per user.
  app.post(
    '/lookup',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const ctx = requireAuth(request, reply)
      if (!ctx) return
      const body = z.object({ url: z.string().min(3).max(2048) }).safeParse(request.body)
      if (!body.success) return reply.code(400).send({ error: 'invalid_input' })
      const parsed = parseLookupUrl(body.data.url)
      if (!parsed) {
        return reply.code(400).send({
          error: 'unsupported_url',
          message: 'Paste a github.com/<owner>/<repo> URL or a beamng.com/resources/… link',
        })
      }
      try {
        const result = await lookupSource(body.data.url)
        return { result }
      } catch (err) {
        return reply.code(502).send({ error: 'lookup_failed', message: (err as Error).message })
      }
    },
  )

  // ─── Auto-detect from URL ─────────────────────────────────────────────────
  // Downloads the zip, hashes it, parses the central directory, and returns
  // BeamNG-aware suggestions for the form.
  app.post('/inspect-url', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const body = z.object({ url: z.string().url(), inspect_id: z.string().optional() }).safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_input' })
    const inspectId = body.data.inspect_id
    const emit = (e: InspectProgressEvent) => emitInspectProgress(inspectId, e)

    const v = validateDownloadUrl(body.data.url)
    if (!v.ok) {
      emit({ phase: 'error', detail: v.message ?? v.reason ?? 'invalid_url' })
      return reply.code(400).send({ error: v.reason, message: v.message })
    }

    const dir = mkdtempSync(join(tmpdir(), 'inspect-'))
    const filePath = join(dir, 'mod.zip')
    try {
      const probe = await probeUrl(body.data.url)
      if (!probe.ok) {
        emit({ phase: 'error', detail: `download_unreachable_${probe.status}` })
        return reply.code(400).send({ error: 'download_unreachable', status: probe.status })
      }
      const ctrl = new AbortController()
      const res = await fetch(body.data.url, { redirect: 'follow', signal: ctrl.signal })
      if (!res.ok || !res.body) {
        emit({ phase: 'error', detail: `download_failed_${res.status}` })
        return reply.code(502).send({ error: 'download_failed', status: res.status })
      }
      // Convert Web ReadableStream → Node Readable for pipeline().
      const { Readable } = await import('node:stream')
      await pipeline(
        Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
        createWriteStream(filePath)
      )
      const result = await inspectZip(filePath, { onProgress: emit })
      return result
    } catch (err) {
      emit({ phase: 'error', detail: (err as Error).message })
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
    // Inspect ID arrives as a query string param (?inspect_id=...) so the
    // browser can correlate the multipart upload with its already-open SSE.
    const inspectId = (request.query as { inspect_id?: string } | undefined)?.inspect_id
    const emit = (e: InspectProgressEvent) => emitInspectProgress(inspectId, e)

    const dir = mkdtempSync(join(tmpdir(), 'inspect-'))
    const filePath = join(dir, 'mod.zip')
    try {
      await pipeline(file.file, createWriteStream(filePath))
      if (file.file.truncated) {
        emit({ phase: 'error', detail: 'file_too_large' })
        return reply.code(413).send({ error: 'file_too_large' })
      }
      const result = await inspectZip(filePath, { onProgress: emit })
      return result
    } catch (err) {
      emit({ phase: 'error', detail: (err as Error).message })
      return reply.code(500).send({ error: 'inspect_failed', message: (err as Error).message })
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  // ─── Chunked upload (Cloudflare-friendly) ────────────────────────────────
  // Cloudflare's free/pro plans cap a single request body at 100 MB. The
  // browser slices the file into chunks (~80 MB) and POSTs each as raw
  // application/octet-stream to this endpoint with ?upload_id, ?chunk_index,
  // ?total_chunks, ?inspect_id. The server appends them to one temp file in
  // order; on the final chunk it runs inspectZip and returns the result.
  // Stale partial uploads are cleaned up by their per-user, per-id naming
  // and the OS tmpdir; we also rm the file at the end whether or not it
  // succeeded.
  const CHUNK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
  const PER_CHUNK_LIMIT = 100 * 1024 * 1024 // 100 MiB hard cap per request
  app.post<{
    Querystring: {
      upload_id?: string
      chunk_index?: string
      total_chunks?: string
      inspect_id?: string
    }
  }>('/inspect-upload-chunk', { bodyLimit: PER_CHUNK_LIMIT }, async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const q = request.query
    const uploadId = q.upload_id ?? ''
    const chunkIndex = Number(q.chunk_index)
    const totalChunks = Number(q.total_chunks)
    const inspectId = q.inspect_id
    if (
      !CHUNK_ID_RE.test(uploadId) ||
      !Number.isInteger(chunkIndex) ||
      !Number.isInteger(totalChunks) ||
      chunkIndex < 0 ||
      totalChunks < 1 ||
      chunkIndex >= totalChunks ||
      totalChunks > 10_000
    ) {
      return reply.code(400).send({ error: 'invalid_chunk_params' })
    }
    const emit = (e: InspectProgressEvent) => emitInspectProgress(inspectId, e)

    const dir = join(tmpdir(), 'inspect-chunked')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${ctx.user.id}-${uploadId}.zip`)

    // Append (or truncate on the first chunk). Out-of-order arrivals would
    // corrupt the file; the client uploads sequentially.
    try {
      // Reject if we'd exceed the configured server-wide max upload size.
      // Approximate via sum of completed chunks: filesize before this write.
      let priorSize = 0
      try { priorSize = chunkIndex === 0 ? 0 : statSync(filePath).size } catch { priorSize = 0 }
      if (priorSize + PER_CHUNK_LIMIT > config.submitMaxUploadBytes + PER_CHUNK_LIMIT) {
        emit({ phase: 'error', detail: 'file_too_large' })
        return reply.code(413).send({ error: 'file_too_large' })
      }

      await pipeline(
        request.raw,
        createWriteStream(filePath, { flags: chunkIndex === 0 ? 'w' : 'a' }),
      )

      if (chunkIndex < totalChunks - 1) {
        return { ok: true, received: chunkIndex + 1, total: totalChunks }
      }

      // Final chunk → inspect.
      try {
        const result = await inspectZip(filePath, { onProgress: emit })
        return result
      } finally {
        try { rmSync(filePath, { force: true }) } catch { /* ignore */ }
      }
    } catch (err) {
      try { rmSync(filePath, { force: true }) } catch { /* ignore */ }
      emit({ phase: 'error', detail: (err as Error).message })
      return reply.code(500).send({ error: 'inspect_failed', message: (err as Error).message })
    }
  })

  // ─── Live progress for an in-flight inspect (SSE) ────────────────────────
  // Browser opens this BEFORE starting the upload, with the same UUID it
  // will pass as ?inspect_id on the upload request. The server pushes phase
  // events (hashing/listing/analyzing/reading_metadata/done) as they happen.
  app.get('/inspect-progress/:id', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const id = (request.params as { id: string }).id
    if (!isValidInspectId(id)) return reply.code(400).send({ error: 'invalid_id' })

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable nginx/Cloudflare buffering so events flush immediately.
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(`retry: 5000\n\n`)

    const send = (e: InspectProgressEvent) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
      if (e.phase === 'done' || e.phase === 'error') {
        reply.raw.end()
      }
    }
    const unsubscribe = subscribeInspect(id, send)
    // Heartbeat so proxies don't kill the idle socket.
    const heartbeat = setInterval(() => {
      try { reply.raw.write(`: ping\n\n`) } catch { /* socket closed */ }
    }, 15_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      closeInspectChannel(id)
    })
    return reply
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

    // Stash the optional upstream-watch hints on the payload so the
    // pipeline can promote them into a netbeammod template. The `x_`
    // prefix matches the schema's extension-fields escape hatch, so the
    // .beammod schema still validates. The pipeline strips them before
    // writing the version .beammod.
    if (parsed.data.watch_kref) {
      ;(payload as Record<string, unknown>).x_watch_kref = parsed.data.watch_kref
    }
    if (parsed.data.watch_filter_asset) {
      ;(payload as Record<string, unknown>).x_watch_filter_asset = parsed.data.watch_filter_asset
    }

    // Identifier consistency.
    if (typeof payload.identifier !== 'string' || payload.identifier !== identifier) {
      return reply.code(400).send({ error: 'identifier_mismatch' })
    }
    if (typeof payload.version !== 'string' || payload.version !== version) {
      return reply.code(400).send({ error: 'version_mismatch' })
    }

    // Ownership-based routing happens further below — anyone can submit;
    // the owner (or admin/green for unowned) decides.

    // Server-side hash (only for kind=package with a download URL).
    const downloadField = (payload as { download?: string | string[] }).download
    if (hash_server_side && downloadField) {
      const url = Array.isArray(downloadField) ? downloadField[0] : downloadField
      if (typeof url !== 'string') {
        return reply.code(400).send({ error: 'invalid_download_url' })
      }
      const dv = validateDownloadUrl(url)
      if (!dv.ok) {
        return reply.code(400).send({ error: dv.reason, message: dv.message })
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

    // Decide trust-tier branch with ownership in mind.
    //  - Admin: always queue.
    //  - Owner of this mod: trust-tier rules apply (green → queued, else pending).
    //  - Non-owner editing an owned mod: ALWAYS pending_review — the owner
    //    must approve (or an admin); other reviewers don't see it.
    //  - Unowned mod already on disk: pending_review (implicit claim review).
    //  - Brand-new identifier (not on disk, no owner): trust-tier rules.
    const ownerId = getOwner(identifier)
    let alreadyOnDisk = false
    try {
      const reg = await getRegistry()
      alreadyOnDisk = reg.byId.has(identifier)
    } catch {
      /* registry index optional in dev */
    }
    let status: 'queued' | 'pending_review'
    if (isAdmin) {
      status = 'queued'
    } else if (ownerId !== null && ownerId !== ctx.user.id) {
      status = 'pending_review'
    } else if (ownerId === null && alreadyOnDisk) {
      status = 'pending_review'
    } else {
      status = ctx.user.trust === 'green' ? 'queued' : 'pending_review'
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

    // Ownership is NEVER granted implicitly by submitting/modifying a mod —
    // even brand-new identifiers. Authors must explicitly claim via the
    // `/claim` endpoint. This avoids surprising users who only intended to
    // contribute an edit (e.g. fixing metadata on someone else's mod).

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

    // Same watch-hint plumbing as /manual.
    if (parsed.data.watch_kref) {
      ;(payload as Record<string, unknown>).x_watch_kref = parsed.data.watch_kref
    }
    if (parsed.data.watch_filter_asset) {
      ;(payload as Record<string, unknown>).x_watch_filter_asset = parsed.data.watch_filter_asset
    }

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
      const dv = validateDownloadUrl(url)
      if (!dv.ok) {
        return reply.code(400).send({ error: dv.reason, message: dv.message })
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

  // ─── Owner workflow ───────────────────────────────────────────────────────
  //
  // Authors can claim mods they wrote (existing entries on disk that have no
  // DB owner). Once owned, all third-party edits to that mod are routed to
  // the owner for approval, not the global reviewer queue.

  // List the mods the current user owns. Returns full mod-card data so the
  // dashboard can render the same tile UI as the registry browser, plus a
  // `pending_count` for any third-party submissions awaiting the owner's
  // review on each mod.
  app.get('/mine/owned', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const owned = listOwnedByUser(ctx.user.id)
    if (owned.length === 0) return { mods: [] }

    const { entries } = await getRegistry()
    const byId = new Map(entries.map((m) => [m.identifier, m]))

    // One indexed scan for last-edit attribution per owned identifier.
    const ownedIds = owned.map((o) => o.identifier)
    const placeholders = ownedIds.map(() => '?').join(',')
    type LastEditRow = {
      identifier: string
      user_id: number
      display_name: string
      avatar_url: string | null
      kind: string
      version: string | null
      decided_at: number | null
    }
    const lastEditRows = ownedIds.length
      ? (db
          .prepare(
            `SELECT s.identifier, s.user_id, s.kind, s.version, s.decided_at,
                    u.display_name, u.avatar_url
               FROM submissions s
               JOIN users u ON u.id = s.user_id
              WHERE s.status IN ('pr_opened','merged')
                AND s.identifier IN (${placeholders})
              ORDER BY COALESCE(s.decided_at, s.created_at) DESC`,
          )
          .all(...ownedIds) as LastEditRow[])
      : []
    const lastEdits = new Map<string, LastEditRow>()
    for (const r of lastEditRows) if (!lastEdits.has(r.identifier)) lastEdits.set(r.identifier, r)

    // Pending submissions per identifier where the submitter is *not* the
    // owner (i.e. genuine third-party edits the owner needs to action).
    const pendingRows = ownedIds.length
      ? (db
          .prepare(
            `SELECT identifier, COUNT(*) AS n
               FROM submissions
              WHERE status IN ('pending_review','changes_requested')
                AND user_id != ?
                AND identifier IN (${placeholders})
              GROUP BY identifier`,
          )
          .all(ctx.user.id, ...ownedIds) as { identifier: string; n: number }[])
      : []
    const pending = new Map<string, number>()
    for (const r of pendingRows) pending.set(r.identifier, r.n)

    // Also surface any pending self-filed delete request per owned mod so
    // the dashboard can show its status and offer a cancel button.
    const deleteRows = ownedIds.length
      ? (db
          .prepare(
            `SELECT identifier, id, status FROM submissions
              WHERE kind = 'delete' AND user_id = ?
                AND status IN ('pending_review','changes_requested','queued')
                AND identifier IN (${placeholders})`,
          )
          .all(ctx.user.id, ...ownedIds) as { identifier: string; id: number; status: string }[])
      : []
    const pendingDelete = new Map<string, { id: number; status: string }>()
    for (const r of deleteRows) pendingDelete.set(r.identifier, { id: r.id, status: r.status })

    const ratings = loadRatings(ctx.user.id)

    const mods = owned.map((o) => {
      const entry = byId.get(o.identifier)
      const base = entry
        ? summarize(entry)
        : {
            // Fallback when an owned mod is no longer present on disk so the
            // UI still shows *something* clickable rather than vanishing.
            identifier: o.identifier,
            name: o.identifier,
            kind: 'package',
            version: '0',
            tags: [] as string[],
            verified: false,
            versions: [] as string[],
          }
      return {
        ...base,
        owner: o,
        last_edit: lastEdits.get(o.identifier) ?? null,
        rating: ratings.get(o.identifier) ?? EMPTY_RATING,
        pending_count: pending.get(o.identifier) ?? 0,
        pending_delete: pendingDelete.get(o.identifier) ?? null,
      }
    })

    return { mods }
  })

  // Submissions made by other users on mods this user owns and that are
  // awaiting the owner's decision. Submissions where the owner is also the
  // submitter are excluded — those go through the normal reviewer queue.
  app.get('/owner-queue', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const rows = db
      .prepare<[number, number], SubmissionRow & { submitter_name: string; submitter_avatar: string | null }>(
        `SELECT s.*, u.display_name AS submitter_name, u.avatar_url AS submitter_avatar
           FROM submissions s
           JOIN mod_ownership o ON o.identifier = s.identifier
           JOIN users u ON u.id = s.user_id
          WHERE o.user_id = ?
            AND s.user_id != ?
            AND s.status IN ('pending_review','changes_requested')
          ORDER BY s.created_at DESC
          LIMIT 200`
      )
      .all(ctx.user.id, ctx.user.id)
    return {
      submissions: rows.map((r) => ({
        ...publicSubmission(r),
        user_id: r.user_id,
        submitter: { display_name: r.submitter_name, avatar_url: r.submitter_avatar },
      })),
    }
  })

  // Owner-side detail view of a pending submission on one of their mods.
  app.get('/owner-queue/:id', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'invalid_input' })
    const row = db
      .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
      .get(id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    if (getOwner(row.identifier) !== ctx.user.id) {
      return reply.code(403).send({ error: 'not_owner' })
    }
    let payload: unknown = null
    try { payload = JSON.parse(row.payload_json) } catch { payload = null }
    const submitter = db
      .prepare<[number], { id: number; display_name: string; avatar_url: string | null; trust: string }>(
        `SELECT id, display_name, avatar_url, trust FROM users WHERE id = ?`
      )
      .get(row.user_id)
    return {
      submission: { ...publicSubmission(row), branch: row.branch, review_note: row.review_note, payload },
      submitter,
    }
  })

  type OwnerGateResult =
    | { ok: true; row: SubmissionRow }
    | { ok: false; error: string; code: number }
  function ownerGate(id: number, userId: number): OwnerGateResult {
    const row = db
      .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
      .get(id)
    if (!row) return { ok: false, error: 'not_found', code: 404 }
    if (getOwner(row.identifier) !== userId) return { ok: false, error: 'not_owner', code: 403 }
    if (row.user_id === userId) return { ok: false, error: 'cannot_review_own', code: 403 }
    return { ok: true, row }
  }

  app.post('/owner-queue/:id/approve', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'invalid_input' })
    const note = (request.body as { note?: string } | null)?.note ?? null
    const gate = ownerGate(id, ctx.user.id)
    if (!gate.ok) return reply.code(gate.code).send({ error: gate.error })
    const row = gate.row
    if (row.status !== 'pending_review' && row.status !== 'changes_requested') {
      return reply.code(409).send({ error: 'wrong_status', status: row.status })
    }
    db.prepare(
      `UPDATE submissions SET status = 'queued', reviewer_id = ?, review_note = ? WHERE id = ?`
    ).run(ctx.user.id, note, id)
    audit({
      actorId: ctx.user.id,
      action: 'owner.submission_approved',
      target: `submission:${id}`,
      details: { identifier: row.identifier },
    })
    runPipeline(id).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[pipeline] error', err)
    })
    return { ok: true }
  })

  app.post('/owner-queue/:id/reject', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'invalid_input' })
    const note = (request.body as { note?: string } | null)?.note ?? null
    const gate = ownerGate(id, ctx.user.id)
    if (!gate.ok) return reply.code(gate.code).send({ error: gate.error })
    const row = gate.row
    const result = db
      .prepare(
        `UPDATE submissions
           SET status = 'rejected', reviewer_id = ?, review_note = ?, decided_at = ?
         WHERE id = ? AND status IN ('pending_review','changes_requested')`
      )
      .run(ctx.user.id, note, Date.now(), id)
    if (result.changes === 0) return reply.code(409).send({ error: 'wrong_status' })
    audit({
      actorId: ctx.user.id,
      action: 'owner.submission_rejected',
      target: `submission:${id}`,
      details: { identifier: row.identifier, note },
    })
    return { ok: true }
  })

  app.post('/owner-queue/:id/request-changes', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'invalid_input' })
    const body = z.object({ note: z.string().trim().min(1).max(4_000) }).safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'note_required' })
    const gate = ownerGate(id, ctx.user.id)
    if (!gate.ok) return reply.code(gate.code).send({ error: gate.error })
    const row = gate.row
    const result = db
      .prepare(
        `UPDATE submissions
           SET status = 'changes_requested', reviewer_id = ?, review_note = ?
         WHERE id = ? AND status = 'pending_review'`
      )
      .run(ctx.user.id, body.data.note, id)
    if (result.changes === 0) return reply.code(409).send({ error: 'wrong_status' })
    audit({
      actorId: ctx.user.id,
      action: 'owner.submission_changes_requested',
      target: `submission:${id}`,
      details: { identifier: row.identifier, note: body.data.note },
    })
    return { ok: true }
  })

  // ─── Claim an existing unowned mod ────────────────────────────────────────
  // The claimant submits a short justification. The submission is queued for
  // green-tier reviewers (who DO see all claims, regardless of mod owner —
  // a claim by definition targets an unowned mod). On approval the claim
  // does NOT run the pipeline; it transfers ownership atomically.
  const ClaimSchema = z.object({
    identifier: z.string().regex(ID_RE),
    message: z.string().trim().max(2_000).optional(),
  })
  app.post('/claim', async (request, reply) => {
    const ctx = requireVerifiedAuth(request, reply)
    if (!ctx) return
    const parsed = ClaimSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues })
    }
    const { identifier, message } = parsed.data

    // The mod must exist on disk (you can't claim a phantom).
    let onDisk = false
    try {
      const reg = await getRegistry()
      onDisk = reg.byId.has(identifier)
    } catch {
      /* in dev, registry might not be ready; fall through to error below */
    }
    if (!onDisk) return reply.code(404).send({ error: 'mod_not_found' })

    // Already owned? Either by you (no-op) or by someone else (forbidden).
    const ownerId = getOwner(identifier)
    if (ownerId === ctx.user.id) {
      return reply.code(409).send({ error: 'already_owned_by_you' })
    }
    if (ownerId !== null) {
      return reply.code(409).send({ error: 'already_owned_by_other' })
    }

    // De-dupe: don't let one user open two pending claims for the same mod.
    const existing = db
      .prepare<[number, string], { id: number }>(
        `SELECT id FROM submissions
          WHERE user_id = ? AND identifier = ? AND kind = 'claim'
            AND status IN ('pending_review','changes_requested')
          LIMIT 1`
      )
      .get(ctx.user.id, identifier)
    if (existing) {
      return reply.code(409).send({ error: 'claim_already_pending', submission_id: existing.id })
    }

    const payload = { identifier, message: message ?? '' }
    const result = db
      .prepare(
        `INSERT INTO submissions
           (user_id, kind, identifier, version, payload_json, status, created_at)
         VALUES (?, 'claim', ?, NULL, ?, 'pending_review', ?)`
      )
      .run(ctx.user.id, identifier, JSON.stringify(payload), Date.now())
    const id = Number(result.lastInsertRowid)

    audit({
      actorId: ctx.user.id,
      action: 'submission.created',
      target: `submission:${id}`,
      details: { kind: 'claim', identifier },
    })

    const row = db
      .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
      .get(id)!
    return { submission: publicSubmission(row) }
  })

  // ─── Relinquish ownership of a mod ────────────────────────────────────────
  // The current owner can release a mod they own. The mod becomes unclaimed
  // and future third-party edits route back to the global reviewer queue.
  // Admins can also use this on any mod.
  app.post('/mine/owned/:identifier/release', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const { identifier } = request.params as { identifier: string }
    const ownerId = getOwner(identifier)
    if (ownerId === null) {
      return reply.code(404).send({ error: 'not_owned' })
    }
    if (ownerId !== ctx.user.id && ctx.user.role !== 'admin') {
      return reply.code(403).send({ error: 'not_owner' })
    }
    const removed = releaseOwnership(identifier, ownerId)
    if (!removed) {
      return reply.code(409).send({ error: 'release_failed' })
    }
    audit({
      actorId: ctx.user.id,
      action: 'ownership.released',
      target: `mod:${identifier}`,
      details: { identifier, previous_owner: ownerId },
    })
    return { ok: true }
  })

  // ─── Owner-initiated deletion request ────────────────────────────────────
  // The current owner of a mod can request its removal from the registry.
  // Final approval is admin-only (enforced in /admin/submissions/:id/approve);
  // this endpoint just queues a `kind='delete'` submission for review. We
  // require a non-empty reason so admins have audit context.
  const RequestDeleteSchema = z.object({
    reason: z.string().trim().min(10).max(2_000),
  })
  app.post('/mine/owned/:identifier/request-delete', async (request, reply) => {
    const ctx = requireVerifiedAuth(request, reply)
    if (!ctx) return
    const { identifier } = request.params as { identifier: string }
    if (!ID_RE.test(identifier)) return reply.code(400).send({ error: 'invalid_identifier' })
    const ownerId = getOwner(identifier)
    if (ownerId === null) return reply.code(404).send({ error: 'not_owned' })
    if (ownerId !== ctx.user.id) return reply.code(403).send({ error: 'not_owner' })
    const parsed = RequestDeleteSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues })
    }

    // The mod must still exist on disk — otherwise there's nothing to delete.
    const reg = await getRegistry()
    if (!reg.byId.has(identifier)) {
      return reply.code(404).send({ error: 'mod_not_found' })
    }

    // Don't queue a second pending delete for the same mod.
    const existing = db
      .prepare<[string], { id: number; user_id: number }>(
        `SELECT id, user_id FROM submissions
          WHERE identifier = ? AND kind = 'delete'
            AND status IN ('pending_review','changes_requested','queued')
          LIMIT 1`
      )
      .get(identifier)
    if (existing) {
      return reply.code(409).send({ error: 'delete_already_pending', submission_id: existing.id })
    }

    const payload = {
      identifier,
      reason: parsed.data.reason,
      requested_by: ctx.user.display_name ?? `user:${ctx.user.id}`,
      is_owner: true,
    }
    const result = db
      .prepare(
        `INSERT INTO submissions
           (user_id, kind, identifier, version, payload_json, status, created_at)
         VALUES (?, 'delete', ?, NULL, ?, 'pending_review', ?)`
      )
      .run(ctx.user.id, identifier, JSON.stringify(payload), Date.now())
    const id = Number(result.lastInsertRowid)

    audit({
      actorId: ctx.user.id,
      action: 'submission.created',
      target: `submission:${id}`,
      details: { kind: 'delete', identifier, reason: parsed.data.reason },
    })

    const row = db
      .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
      .get(id)!
    return { submission: publicSubmission(row) }
  })

  // Cancel a still-pending delete request the user filed themselves.
  app.delete('/mine/owned/:identifier/request-delete', async (request, reply) => {
    const ctx = requireAuth(request, reply)
    if (!ctx) return
    const { identifier } = request.params as { identifier: string }
    const row = db
      .prepare<[string, number], { id: number; status: string }>(
        `SELECT id, status FROM submissions
          WHERE identifier = ? AND kind = 'delete' AND user_id = ?
            AND status IN ('pending_review','changes_requested')
          ORDER BY id DESC LIMIT 1`
      )
      .get(identifier, ctx.user.id)
    if (!row) return reply.code(404).send({ error: 'no_pending_delete' })
    const result = db
      .prepare(
        `UPDATE submissions
           SET status = 'rejected', decided_at = ?, review_note = 'cancelled by submitter'
         WHERE id = ? AND status IN ('pending_review','changes_requested')`
      )
      .run(Date.now(), row.id)
    if (result.changes === 0) return reply.code(409).send({ error: 'wrong_status' })
    audit({
      actorId: ctx.user.id,
      action: 'submission.cancelled',
      target: `submission:${row.id}`,
      details: { kind: 'delete', identifier },
    })
    return { ok: true }
  })

  // ─── Stubs for the remaining flows (return 501 until implemented) ─────────
  for (const path of ['/netbeammod-github', '/netbeammod-beamng', '/new-version']) {
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
