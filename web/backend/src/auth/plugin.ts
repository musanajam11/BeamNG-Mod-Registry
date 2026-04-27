/**
 * Fastify plugin that:
 *  - Loads the session for each request and attaches it to `request.ctx`.
 *  - Issues / validates a double-submit CSRF token.
 *  - Provides `requireAuth` and `requireAdmin` helpers for routes.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from '../util/fp.js'
import { config } from '../config.js'
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  constantTimeEqual,
  loadSession,
  newToken,
  type SessionContext,
} from './session.js'

declare module 'fastify' {
  interface FastifyRequest {
    ctx: SessionContext | null
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function setCsrfCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(CSRF_COOKIE, token, {
    path: '/',
    httpOnly: false, // frontend reads this to mirror in header
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
  })
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('ctx', null)

  app.addHook('onRequest', async (request, reply) => {
    const sid = request.cookies[SESSION_COOKIE]
    if (sid) {
      const unsigned = request.unsignCookie(sid)
      if (unsigned.valid && unsigned.value) {
        request.ctx = loadSession(unsigned.value)
      } else {
        request.ctx = null
      }
    } else {
      request.ctx = null
    }

    // Ensure a CSRF cookie always exists.
    if (!request.cookies[CSRF_COOKIE]) {
      setCsrfCookie(reply, newToken(24))
    }
  })

  app.addHook('preHandler', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return
    // Allow login/signup CSRF-free? No — the cookie is set on first GET so
    // even unauthenticated POSTs must echo the CSRF token. The frontend
    // performs a GET /api/auth/csrf on boot to guarantee the cookie exists.
    const cookieToken = request.cookies[CSRF_COOKIE]
    const headerToken = request.headers[CSRF_HEADER]
    if (
      !cookieToken ||
      typeof headerToken !== 'string' ||
      !constantTimeEqual(cookieToken, headerToken)
    ) {
      reply.code(403).send({ error: 'csrf_failed' })
    }
  })
})

export function requireAuth(request: FastifyRequest, reply: FastifyReply): SessionContext | null {
  if (!request.ctx) {
    reply.code(401).send({ error: 'unauthenticated' })
    return null
  }
  if (request.ctx.user.trust === 'red') {
    reply.code(403).send({ error: 'account_blocked' })
    return null
  }
  return request.ctx
}

/**
 * Stronger gate for actions that publish content publicly. When email
 * verification is required by config, refuses unverified accounts. Admins
 * always pass.
 */
export function requireVerifiedAuth(
  request: FastifyRequest,
  reply: FastifyReply
): SessionContext | null {
  const ctx = requireAuth(request, reply)
  if (!ctx) return null
  if (ctx.user.role === 'admin') return ctx
  if (config.email.verificationRequired && !ctx.user.email_verified) {
    reply.code(403).send({ error: 'email_verification_required' })
    return null
  }
  return ctx
}

export function requireAdmin(request: FastifyRequest, reply: FastifyReply): SessionContext | null {
  const ctx = requireAuth(request, reply)
  if (!ctx) return null
  if (ctx.user.role !== 'admin') {
    reply.code(403).send({ error: 'admin_required' })
    return null
  }
  return ctx
}
