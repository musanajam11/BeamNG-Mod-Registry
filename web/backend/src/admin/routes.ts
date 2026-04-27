/**
 * Admin routes: list users, change trust tier / role, list pending
 * submissions, approve / reject, view audit log.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, type SubmissionRow, type UserRow } from '../db.js'
import { audit } from '../audit.js'
import { requireAdmin, requireReviewer } from '../auth/plugin.js'
import { runPipeline } from '../submissions/pipeline.js'
import { getGithubConfig, isGithubReady, setSetting, GITHUB_KEYS, getTheme, THEME_KEYS, getTurnstileConfig, isTurnstileReady, TURNSTILE_KEYS } from '../settings.js'
import { invalidateGithubCache, getInstallationOctokit } from '../github/app.js'

const TrustEnum = z.enum(['green', 'yellow', 'red'])
const RoleEnum = z.enum(['user', 'admin'])

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    const rows = db
      .prepare<[], UserRow>(
        `SELECT * FROM users ORDER BY created_at DESC LIMIT 500`
      )
      .all()
    return {
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        display_name: u.display_name,
        role: u.role,
        trust: u.trust,
        github_username: u.github_username,
        created_at: u.created_at,
        last_login_at: u.last_login_at,
      })),
    }
  })

  app.post('/users/:id/trust', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    const body = z.object({ trust: TrustEnum }).safeParse(request.body)
    if (!body.success || !id) return reply.code(400).send({ error: 'invalid_input' })
    db.prepare('UPDATE users SET trust = ? WHERE id = ?').run(body.data.trust, id)
    audit({
      actorId: ctx.user.id,
      action: 'admin.trust_change',
      target: `user:${id}`,
      details: { trust: body.data.trust },
    })
    return { ok: true }
  })

  app.post('/users/:id/role', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    const body = z.object({ role: RoleEnum }).safeParse(request.body)
    if (!body.success || !id) return reply.code(400).send({ error: 'invalid_input' })
    if (id === ctx.user.id && body.data.role !== 'admin') {
      return reply.code(400).send({ error: 'cannot_demote_self' })
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.data.role, id)
    audit({
      actorId: ctx.user.id,
      action: 'admin.role_change',
      target: `user:${id}`,
      details: { role: body.data.role },
    })
    return { ok: true }
  })

  // Manual email-verification override. Useful when SMTP is misconfigured
  // or the user reports never receiving the link.
  app.post('/users/:id/verify-email', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'invalid_input' })
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(id)
    audit({
      actorId: ctx.user.id,
      action: 'admin.email_verified',
      target: `user:${id}`,
    })
    return { ok: true }
  })

  app.get('/submissions', async (request, reply) => {
    const ctx = requireReviewer(request, reply)
    if (!ctx) return
    const status = (request.query as { status?: string } | undefined)?.status
    const rows = status
      ? db
          .prepare<[string], SubmissionRow>(
            `SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC LIMIT 500`
          )
          .all(status)
      : db
          .prepare<[], SubmissionRow>(
            `SELECT * FROM submissions ORDER BY created_at DESC LIMIT 500`
          )
          .all()
    return { submissions: rows }
  })

  app.get('/submissions/:id', async (request, reply) => {
    const ctx = requireReviewer(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'invalid_input' })
    const sub = db
      .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
      .get(id)
    if (!sub) return reply.code(404).send({ error: 'not_found' })
    const submitter = db
      .prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?')
      .get(sub.user_id)
    let payload: unknown = null
    try { payload = JSON.parse(sub.payload_json) } catch { payload = null }
    return {
      submission: {
        id: sub.id,
        user_id: sub.user_id,
        kind: sub.kind,
        identifier: sub.identifier,
        version: sub.version,
        status: sub.status,
        pr_url: sub.pr_url,
        branch: sub.branch,
        reviewer_id: sub.reviewer_id,
        review_note: sub.review_note,
        error: sub.error,
        created_at: sub.created_at,
        decided_at: sub.decided_at,
        payload,
      },
      submitter: submitter
        ? {
            id: submitter.id,
            email: submitter.email,
            display_name: submitter.display_name,
            role: submitter.role,
            trust: submitter.trust,
            created_at: submitter.created_at,
          }
        : null,
    }
  })

  app.post('/submissions/:id/approve', async (request, reply) => {
    const ctx = requireReviewer(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'invalid_input' })
    const note = (request.body as { note?: string } | null)?.note ?? null

    const sub = db
      .prepare<[number], SubmissionRow>('SELECT * FROM submissions WHERE id = ?')
      .get(id)
    if (!sub) return reply.code(404).send({ error: 'not_found' })
    if (sub.user_id === ctx.user.id && ctx.user.role !== 'admin') {
      return reply.code(403).send({ error: 'cannot_review_own' })
    }
    if (sub.status !== 'pending_review' && sub.status !== 'changes_requested') {
      return reply.code(409).send({ error: 'wrong_status', status: sub.status })
    }

    db.prepare(
      `UPDATE submissions SET status = 'queued', reviewer_id = ?, review_note = ? WHERE id = ?`
    ).run(ctx.user.id, note, id)
    audit({
      actorId: ctx.user.id,
      action: 'admin.submission_approved',
      target: `submission:${id}`,
    })
    runPipeline(id).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[pipeline] error', err)
    })
    return { ok: true }
  })

  app.post('/submissions/:id/reject', async (request, reply) => {
    const ctx = requireReviewer(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    const note = (request.body as { note?: string } | null)?.note ?? null
    if (!id) return reply.code(400).send({ error: 'invalid_input' })
    if (ctx.user.role !== 'admin') {
      const owner = db
        .prepare<[number], { user_id: number }>('SELECT user_id FROM submissions WHERE id = ?')
        .get(id)
      if (owner && owner.user_id === ctx.user.id) {
        return reply.code(403).send({ error: 'cannot_review_own' })
      }
    }
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
      action: 'admin.submission_rejected',
      target: `submission:${id}`,
      details: { note },
    })
    return { ok: true }
  })

  // Middle-ground decision: ask the submitter to edit and resubmit. The
  // submitter is expected to update payload via POST /submissions/mine/:id/resubmit
  // which moves the row back to `pending_review` for another round.
  app.post('/submissions/:id/request-changes', async (request, reply) => {
    const ctx = requireReviewer(request, reply)
    if (!ctx) return
    const id = Number((request.params as { id: string }).id)
    if (!id) return reply.code(400).send({ error: 'invalid_input' })
    const body = z
      .object({ note: z.string().trim().min(1).max(4_000) })
      .safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ error: 'note_required', issues: body.error.issues })
    }
    if (ctx.user.role !== 'admin') {
      const owner = db
        .prepare<[number], { user_id: number }>('SELECT user_id FROM submissions WHERE id = ?')
        .get(id)
      if (owner && owner.user_id === ctx.user.id) {
        return reply.code(403).send({ error: 'cannot_review_own' })
      }
    }
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
      action: 'admin.submission_changes_requested',
      target: `submission:${id}`,
      details: { note: body.data.note },
    })
    return { ok: true }
  })

  app.get('/audit', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    const rows = db
      .prepare(
        `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500`
      )
      .all()
    return { entries: rows }
  })

  // ─── Settings: GitHub App configuration ─────────────────────────────────
  // Stored in the `settings` table; overrides corresponding env vars at
  // runtime so admins don't need to restart the container.
  app.get('/settings/github', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    const g = getGithubConfig()
    return {
      configured: isGithubReady(),
      app_id: g.appId ?? '',
      // Only echo back whether a private key is set, never the bytes.
      private_key_set: Boolean(g.privateKey),
      installation_id: g.installationId ?? '',
      repo_owner: g.repoOwner ?? '',
      repo_name: g.repoName,
      default_branch: g.defaultBranch,
      auto_merge: g.autoMerge,
    }
  })

  const GithubSettingsSchema = z.object({
    app_id: z.string().trim().max(20).optional(),
    // Private key is optional on each save: empty/absent string keeps the
    // existing value. To clear, send the literal string '__clear__'.
    private_key: z.string().max(16_384).optional(),
    installation_id: z.string().trim().max(20).optional(),
    repo_owner: z.string().trim().max(64).optional(),
    repo_name: z.string().trim().max(128).optional(),
    default_branch: z.string().trim().max(128).optional(),
    auto_merge: z.boolean().optional(),
  })

  app.post('/settings/github', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    const parsed = GithubSettingsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues })
    }
    const b = parsed.data
    const actor = ctx.user.id
    const changed: string[] = []
    const setIf = (key: string, val: string | undefined) => {
      if (val === undefined) return
      setSetting(key, val.trim(), actor)
      changed.push(key)
    }
    setIf(GITHUB_KEYS.appId, b.app_id)
    if (b.private_key !== undefined) {
      if (b.private_key === '__clear__') {
        setSetting(GITHUB_KEYS.privateKey, '', actor)
        changed.push(GITHUB_KEYS.privateKey)
      } else if (b.private_key.trim()) {
        // Normalize PEM: strip BOM/CR, trim, ensure trailing newline. Pasted
        // keys often arrive with Windows line endings or smart quotes that
        // break @octokit/app's JWT signer with cryptic errors.
        const normalized = b.private_key
          .replace(/^\uFEFF/, '')
          .replace(/\r\n?/g, '\n')
          .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
          .trim() + '\n'
        setSetting(GITHUB_KEYS.privateKey, normalized, actor)
        changed.push(GITHUB_KEYS.privateKey)
      }
    }
    setIf(GITHUB_KEYS.installationId, b.installation_id)
    setIf(GITHUB_KEYS.repoOwner, b.repo_owner)
    setIf(GITHUB_KEYS.repoName, b.repo_name)
    setIf(GITHUB_KEYS.defaultBranch, b.default_branch)
    if (b.auto_merge !== undefined) {
      setSetting(GITHUB_KEYS.autoMerge, b.auto_merge ? '1' : '0', actor)
      changed.push(GITHUB_KEYS.autoMerge)
    }

    invalidateGithubCache()
    audit({
      actorId: actor,
      action: 'admin.settings.github_updated',
      details: { keys: changed },
    })
    return { ok: true, configured: isGithubReady() }
  })

  // Probe that the configured App can authenticate against the configured
  // installation and read the registry repo. Used by the "Test connection"
  // button in the admin settings UI.
  app.post('/settings/github/test', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    if (!isGithubReady()) {
      return reply.code(400).send({ error: 'not_configured' })
    }
    try {
      const g = getGithubConfig()
      const octokit = await getInstallationOctokit()
      const { data } = await octokit.repos.get({ owner: g.repoOwner!, repo: g.repoName })
      return {
        ok: true,
        repo: { full_name: data.full_name, default_branch: data.default_branch, private: data.private },
      }
    } catch (err) {
      // Surface the underlying cause to both the server log and the admin UI.
      // Most failures here are PEM parse errors, wrong installation ID, or the
      // App not being installed on the target repo.
      const e = err as { message?: string; status?: number; code?: string; name?: string }
      request.log.error({ err: e, msg: 'github test_connection failed' }, 'github_test_failed')
      return reply.code(502).send({
        error: 'github_test_failed',
        message: e?.message || e?.code || e?.name || 'unknown error',
        status: e?.status,
      })
    }
  })

  // ─── Settings: theme / appearance ───────────────────────────────────────
  app.get('/settings/theme', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    return getTheme()
  })

  const ThemeSettingsSchema = z.object({
    background_url: z.string().trim().max(2048).url().or(z.literal('')).optional(),
    background_blur_px: z.number().int().min(0).max(60).optional(),
    background_dim_pct: z.number().int().min(0).max(90).optional(),
    primary_color: z
      .enum([
        'blue', 'cyan', 'teal', 'green', 'lime', 'yellow', 'orange', 'red',
        'pink', 'grape', 'violet', 'indigo', 'gray', 'dark',
      ])
      .optional(),
    color_scheme: z.enum(['auto', 'light', 'dark']).optional(),
    app_name: z.string().trim().min(1).max(64).optional(),
    apply_to_auth_only: z.boolean().optional(),
  })

  app.post('/settings/theme', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    const parsed = ThemeSettingsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues })
    }
    const b = parsed.data
    const actor = ctx.user.id
    const changed: string[] = []
    const setStr = (k: string, v: string | undefined) => {
      if (v === undefined) return
      setSetting(k, v.trim(), actor)
      changed.push(k)
    }
    const setNum = (k: string, v: number | undefined) => {
      if (v === undefined) return
      setSetting(k, String(v), actor)
      changed.push(k)
    }
    setStr(THEME_KEYS.backgroundUrl, b.background_url)
    setNum(THEME_KEYS.backgroundBlurPx, b.background_blur_px)
    setNum(THEME_KEYS.backgroundDimPct, b.background_dim_pct)
    setStr(THEME_KEYS.primaryColor, b.primary_color)
    setStr(THEME_KEYS.colorScheme, b.color_scheme)
    setStr(THEME_KEYS.appName, b.app_name)
    if (b.apply_to_auth_only !== undefined) {
      setSetting(THEME_KEYS.applyToAuthOnly, b.apply_to_auth_only ? '1' : '0', actor)
      changed.push(THEME_KEYS.applyToAuthOnly)
    }
    audit({
      actorId: actor,
      action: 'admin.settings.theme_updated',
      details: { keys: changed },
    })
    return { ok: true, theme: getTheme() }
  })

  // ─── Settings: Cloudflare Turnstile ─────────────────────────────────────
  app.get('/settings/turnstile', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    const t = getTurnstileConfig()
    return {
      configured: isTurnstileReady(),
      site_key: t.siteKey ?? '',
      // Never echo the secret; just whether one is set.
      secret_key_set: Boolean(t.secretKey),
    }
  })

  const TurnstileSettingsSchema = z.object({
    site_key: z.string().trim().max(128).optional(),
    // Send '__clear__' to wipe the stored secret. Empty/undefined keeps it.
    secret_key: z.string().max(256).optional(),
  })

  app.post('/settings/turnstile', async (request, reply) => {
    const ctx = requireAdmin(request, reply)
    if (!ctx) return
    const parsed = TurnstileSettingsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues })
    }
    const b = parsed.data
    const actor = ctx.user.id
    const changed: string[] = []
    if (b.site_key !== undefined) {
      setSetting(TURNSTILE_KEYS.siteKey, b.site_key.trim(), actor)
      changed.push(TURNSTILE_KEYS.siteKey)
    }
    if (b.secret_key !== undefined) {
      if (b.secret_key === '__clear__') {
        setSetting(TURNSTILE_KEYS.secretKey, '', actor)
        changed.push(TURNSTILE_KEYS.secretKey)
      } else if (b.secret_key.trim()) {
        setSetting(TURNSTILE_KEYS.secretKey, b.secret_key.trim(), actor)
        changed.push(TURNSTILE_KEYS.secretKey)
      }
    }
    audit({
      actorId: actor,
      action: 'admin.settings.turnstile_updated',
      details: { keys: changed },
    })
    return { ok: true, configured: isTurnstileReady() }
  })
}
