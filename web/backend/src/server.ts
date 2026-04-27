/**
 * Server bootstrap: builds the Fastify app, registers plugins/routes, and
 * starts listening. Static frontend assets are served from frontend/dist
 * when present (production); in dev the Vite server runs separately on
 * :5173 and proxies /api to this server.
 */
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import staticPlugin from '@fastify/static'
import multipart from '@fastify/multipart'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { assertProductionReady } from './config.js'
import { authPlugin } from './auth/plugin.js'
import { authRoutes } from './auth/routes.js'
import { submissionRoutes } from './submissions/routes.js'
import { adminRoutes } from './admin/routes.js'
import { publicRoutes } from './routes/public.js'
import { pruneExpiredSessions } from './auth/session.js'
import { startMergePoller } from './submissions/merge-poller.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function buildApp() {
  const app = Fastify({
    logger: { level: config.isProd ? 'info' : 'debug' },
    trustProxy: config.trustProxy.length > 0 ? config.trustProxy : false,
    bodyLimit: 2 * 1024 * 1024, // 2 MiB JSON cap; uploads are not supported in v1
  })

  const publicOriginIsHttps = config.publicOrigin.startsWith('https://')
  await app.register(helmet, {
    // Helmet's default CSP injects `upgrade-insecure-requests`, which breaks
    // any deployment whose PUBLIC_ORIGIN is plain http:// (LAN-only / pre-TLS
    // testing) — the browser tries to fetch assets over https and fails.
    // Only include that directive when we know the public origin is HTTPS.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Turnstile loads its widget from challenges.cloudflare.com.
        // Cloudflare proxy auto-injects a beacon from static.cloudflareinsights.com
        // (Web Analytics) — allow it so the console isn't full of CSP noise.
        scriptSrc: [
          "'self'",
          'https://challenges.cloudflare.com',
          // Cloudflare Web Analytics. We ship a manual <script> tag in
          // index.html, but when the zone has "Automatic Setup" enabled the
          // CF proxy also injects a tiny inline bootstrap. Allow its hash
          // so CSP doesn't block it. If CF rotates the bootstrap, copy the
          // new sha256-... value from the browser console error.
          'https://static.cloudflareinsights.com',
          "'sha256-ieoeWczDHkReVBsRBqaal5AFMlBtNjMzgwKvLqi/tSU='",
        ],
        styleSrc: ["'self'", "'unsafe-inline'"], // Mantine emits some inline styles
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: [
          "'self'",
          'https://challenges.cloudflare.com',
          'https://cloudflareinsights.com',
          'https://*.cloudflareinsights.com',
        ],
        frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // `null` removes the directive that helmet's defaults would otherwise add.
        upgradeInsecureRequests: publicOriginIsHttps ? [] : null,
      },
    },
    // HSTS only makes sense when actually served over HTTPS.
    strictTransportSecurity: publicOriginIsHttps ? undefined : false,
  })
  await app.register(cookie, { secret: config.sessionSecret })
  await app.register(rateLimit, {
    global: false, // opt-in per route group
    max: 60,
    timeWindow: '1 minute',
  })
  await app.register(multipart, {
    limits: {
      fileSize: config.submitMaxUploadBytes,
      files: 1,
      fields: 10,
    },
  })
  // Passthrough parser for raw binary chunked uploads (used by
  // /submissions/inspect-upload-chunk to bypass Cloudflare's 100 MB per-
  // request body cap). Each chunk is streamed straight to disk; the route
  // sets its own bodyLimit.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload)
  })
  await app.register(authPlugin)

  await app.register(
    async (api) => {
      await api.register(async (sub) => {
        // Rate-limit only mutating auth calls (login/signup/logout). GETs
        // like /auth/me and /auth/csrf are hit on every page load and would
        // otherwise exhaust the budget during normal use. Per-account
        // brute-force throttling is enforced separately inside the login
        // handler.
        await sub.register(rateLimit, {
          max: 30,
          timeWindow: '1 minute',
          // allowList may be an array of keys OR a predicate; returning
          // `true` skips the limiter entirely for that request.
          allowList: (req) => req.method === 'GET' || req.method === 'HEAD',
        })
        await sub.register(authRoutes, { prefix: '/auth' })
      })
      await api.register(async (sub) => {
        await sub.register(rateLimit, { max: 30, timeWindow: '1 minute' })
        await sub.register(submissionRoutes, { prefix: '/submissions' })
      })
      await api.register(adminRoutes, { prefix: '/admin' })
      await api.register(publicRoutes, { prefix: '/' })
    },
    { prefix: '/api' }
  )

  // Static frontend (production). In dev, hit the Vite server directly.
  const frontendDist = join(__dirname, '..', '..', 'frontend', 'dist')
  if (existsSync(frontendDist)) {
    await app.register(staticPlugin, { root: frontendDist, prefix: '/' })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) {
        return reply.code(404).send({ error: 'not_found' })
      }
      // SPA fallback.
      return reply.type('text/html').sendFile('index.html')
    })
  }

  return app
}

async function main() {
  assertProductionReady()
  const app = await buildApp()

  // Periodic session GC.
  const interval = setInterval(pruneExpiredSessions, 60 * 60 * 1000).unref()
  void interval

  // Poll GitHub for PR merges so submissions transition pr_opened -> merged
  // (powers contribution attribution + history on the registry browser).
  startMergePoller()

  try {
    await app.listen({ port: config.port, host: config.host })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

void main()
