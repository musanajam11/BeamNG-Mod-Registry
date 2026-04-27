/**
 * Auth routes: signup, login, logout, me.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'
import { audit } from '../audit.js'
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  destroySession,
  hashPassword,
  isLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
  verifyPassword,
} from './session.js'
import { verifyTurnstile } from './turnstile.js'
import { getTurnstileConfig } from '../settings.js'
import { sendVerificationEmail } from './email.js'
import { createEmailVerificationToken } from './emailTokens.js'
import { consumeEmailVerificationToken } from './emailTokens.js'
import type { UserRow } from '../db.js'

const SignupSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(12).max(256),
  display_name: z.string().min(2).max(64).regex(/^[A-Za-z0-9 _.\-]+$/),
  turnstile_token: z.string().max(4096).optional(),
})

const LoginSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(256),
  turnstile_token: z.string().max(4096).optional(),
})

function setSessionCookie(reply: import('fastify').FastifyReply, sid: string): void {
  reply.setCookie(SESSION_COOKIE, sid, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    signed: true,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    trust: u.trust,
    github_username: u.github_username,
    email_verified: !!u.email_verified,
    created_at: u.created_at,
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Endpoint exists purely so the frontend can ensure the CSRF cookie is set
  // before performing its first POST.
  app.get('/csrf', async () => ({ ok: true }))

  app.get('/me', async (request) => {
    return { user: request.ctx ? publicUser(request.ctx.user) : null }
  })

  app.post('/signup', async (request, reply) => {
    const parsed = SignupSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', issues: parsed.error.issues })
    }
    const { email, password, display_name, turnstile_token } = parsed.data

    const captcha = await verifyTurnstile(turnstile_token, request.ip)
    if (!captcha.ok) {
      return reply.code(400).send({ error: 'captcha_failed', reason: captcha.reason })
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (existing) {
      // Generic message to avoid email enumeration.
      return reply.code(400).send({ error: 'signup_failed' })
    }

    const hash = await hashPassword(password)
    const isBootstrap =
      config.bootstrapAdminEmail !== undefined && config.bootstrapAdminEmail === email
    const role = isBootstrap ? 'admin' : 'user'
    const trust = isBootstrap ? 'green' : 'yellow'

    const result = db
      .prepare(
        `INSERT INTO users (email, password_hash, display_name, role, trust, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(email, hash, display_name, role, trust, Date.now())
    const userId = Number(result.lastInsertRowid)

    audit({
      actorId: userId,
      action: 'user.signup',
      target: `user:${userId}`,
      details: { email, role, trust },
    })

    // Fire off the verification email if SMTP is configured. Failure is
    // non-fatal — admins can still verify the account from the admin UI.
    try {
      const token = createEmailVerificationToken(userId)
      await sendVerificationEmail(email, display_name, token)
    } catch (err) {
      request.log.warn({ err }, 'failed to send verification email')
    }

    const sid = createSession(userId, request.ip, request.headers['user-agent'] ?? null)
    setSessionCookie(reply, sid)
    const user = db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?').get(userId)!
    return { user: publicUser(user) }
  })

  app.post('/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input' })
    }
    const { email, password, turnstile_token } = parsed.data

    const captcha = await verifyTurnstile(turnstile_token, request.ip)
    if (!captcha.ok) {
      return reply.code(400).send({ error: 'captcha_failed', reason: captcha.reason })
    }

    const user = db.prepare<[string], UserRow>('SELECT * FROM users WHERE email = ?').get(email)
    if (!user) {
      // Constant-ish time: still hash a dummy password.
      await verifyPassword('$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$x', password)
      return reply.code(401).send({ error: 'invalid_credentials' })
    }
    if (isLocked(user)) {
      return reply.code(429).send({ error: 'account_locked' })
    }
    const ok = await verifyPassword(user.password_hash, password)
    if (!ok) {
      recordFailedLogin(user.id)
      audit({ actorId: user.id, action: 'user.login_failed', target: `user:${user.id}` })
      return reply.code(401).send({ error: 'invalid_credentials' })
    }
    recordSuccessfulLogin(user.id)
    audit({ actorId: user.id, action: 'user.login', target: `user:${user.id}` })
    const sid = createSession(user.id, request.ip, request.headers['user-agent'] ?? null)
    setSessionCookie(reply, sid)
    return { user: publicUser(user) }
  })

  app.post('/logout', async (request, reply) => {
    if (request.ctx) {
      destroySession(request.ctx.session.id)
      audit({ actorId: request.ctx.user.id, action: 'user.logout' })
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  // Public config so the frontend can render Turnstile + email-verify gates
  // without leaking secrets. Cheap (handful of strings) and unauthenticated
  // by design.
  app.get('/config', async () => ({
    turnstile_site_key: getTurnstileConfig().siteKey ?? null,
    email_verification_required: config.email.verificationRequired,
  }))

  // Email verification: GET because users click the link in mail clients.
  // Idempotent on subsequent visits (already-verified accounts return ok).
  app.get('/verify-email', async (request, reply) => {
    const token = (request.query as { token?: string } | undefined)?.token
    if (!token || typeof token !== 'string') {
      return reply.code(400).send({ error: 'invalid_token' })
    }
    const userId = consumeEmailVerificationToken(token)
    if (!userId) return reply.code(400).send({ error: 'invalid_or_expired' })
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId)
    audit({ actorId: userId, action: 'user.email_verified', target: `user:${userId}` })
    return { ok: true }
  })

  app.post('/resend-verification', async (request, reply) => {
    const ctx = request.ctx
    if (!ctx) return reply.code(401).send({ error: 'auth_required' })
    if (ctx.user.email_verified) return { ok: true, already_verified: true }
    try {
      const token = createEmailVerificationToken(ctx.user.id)
      await sendVerificationEmail(ctx.user.email, ctx.user.display_name, token)
    } catch (err) {
      request.log.warn({ err }, 'failed to resend verification email')
      return reply.code(500).send({ error: 'send_failed' })
    }
    return { ok: true }
  })
}
