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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { assertProductionReady } from './config.js'
import { authPlugin } from './auth/plugin.js'
import { authRoutes } from './auth/routes.js'
import { submissionRoutes } from './submissions/routes.js'
import { adminRoutes } from './admin/routes.js'
import { publicRoutes } from './routes/public.js'
import { backendsRoutes } from './routes/backends.js'
import {
  fetchBeamMpServerInfo,
  getInviteLink,
  inviteRoutes,
  isValidInviteCode,
  type BeamMpServerInfo,
  type InviteLinkRow,
} from './routes/invite.js'
import { pruneExpiredSessions } from './auth/session.js'
import { startMergePoller } from './submissions/merge-poller.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CM_LOGO_URL = 'https://raw.githubusercontent.com/musanajam11/BeamNG-Content-Manager/main/build/icon.png'

type InviteSeoMetadata = {
  title: string
  description: string
  url: string
  image: string
  imageAlt: string
  siteName: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stripBeamFormatting(value: unknown): string {
  return String(value ?? '')
    .replace(/\^[0-9a-frlomn]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function humanizeMapName(raw: unknown): string {
  const input = String(raw ?? '').trim()
  if (!input) return 'Unknown'

  const levelMatch = input.match(/\/levels\/([^/]+)/i)
  const slug = levelMatch?.[1] ?? input.split('/').filter(Boolean).at(-1) ?? input
  const clean = slug
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()

  if (!clean) return 'Unknown'
  return clean
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1).trimEnd()}…`
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function buildInviteSeoMetadata(
  code: string,
  invite: InviteLinkRow | null,
  serverInfo: BeamMpServerInfo | null
): InviteSeoMetadata {
  const url = `${config.publicOrigin}/j/${encodeURIComponent(code)}`
  const image = CM_LOGO_URL

  if (!invite) {
    return {
      title: 'Invalid BeamMP Invite | BeamNG Content Manager',
      description: 'This BeamMP invite link is invalid or expired. Ask the server owner for a fresh invite and open it in BeamNG Content Manager.',
      url,
      image,
      imageAlt: 'BeamNG Content Manager logo',
      siteName: 'BeamNG Content Manager',
    }
  }

  if (!serverInfo) {
    return {
      title: 'BeamMP Invite | BeamNG Content Manager',
      description: `Open this BeamMP invite in BeamNG Content Manager to join ${invite.ip}:${invite.port}.`,
      url,
      image,
      imageAlt: 'BeamNG Content Manager logo',
      siteName: 'BeamNG Content Manager',
    }
  }

  const serverName = stripBeamFormatting(serverInfo.sname) || 'BeamMP server'
  const serverDescription = stripBeamFormatting(serverInfo.sdesc)
  const mapName = humanizeMapName(serverInfo.map)
  const players = String(serverInfo.players ?? '').trim()
  const maxPlayers = String(serverInfo.maxplayers ?? '').trim()
  const modsTotal = String(serverInfo.modstotal ?? '').trim()
  const descriptionParts = [
    `Join ${serverName} on ${mapName}.`,
    players && maxPlayers ? `${players}/${maxPlayers} players online.` : '',
    modsTotal ? `${modsTotal} mods loaded.` : '',
    isTruthyFlag(serverInfo.password) ? 'Password protected.' : '',
    serverDescription,
  ].filter(Boolean)

  return {
    title: `${serverName} | BeamMP Invite`,
    description: truncateText(descriptionParts.join(' '), 220),
    url,
    image,
    imageAlt: 'BeamNG Content Manager logo',
    siteName: 'BeamNG Content Manager',
  }
}

function replaceTagContent(html: string, tagName: string, content: string): string {
  const escaped = escapeHtml(content)
  return html.replace(new RegExp(`<${tagName}>[^<]*</${tagName}>`, 'i'), `<${tagName}>${escaped}</${tagName}>`)
}

function replaceMetaContent(html: string, attr: 'name' | 'property', key: string, content: string): string {
  const escaped = escapeHtml(content)
  const keyPattern = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`<meta\\s+${attr}="${keyPattern}"\\s+content="[^"]*"\\s*/?>`, 'i')
  return html.replace(pattern, `<meta ${attr}="${key}" content="${escaped}" />`)
}

function renderInviteIndexHtml(template: string, metadata: InviteSeoMetadata): string {
  let html = template
  html = replaceTagContent(html, 'title', metadata.title)
  html = replaceMetaContent(html, 'name', 'description', metadata.description)
  html = replaceMetaContent(html, 'property', 'og:site_name', metadata.siteName)
  html = replaceMetaContent(html, 'property', 'og:title', metadata.title)
  html = replaceMetaContent(html, 'property', 'og:description', metadata.description)
  html = replaceMetaContent(html, 'property', 'og:url', metadata.url)
  html = replaceMetaContent(html, 'property', 'og:image', metadata.image)
  html = replaceMetaContent(html, 'property', 'og:image:alt', metadata.imageAlt)
  html = replaceMetaContent(html, 'name', 'twitter:title', metadata.title)
  html = replaceMetaContent(html, 'name', 'twitter:description', metadata.description)
  html = replaceMetaContent(html, 'name', 'twitter:image', metadata.image)
  return html
}

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
        // Only throttle mutating submission calls. Read-only endpoints like
        // /submissions/mine/owned and /submissions/owner-queue are polled
        // from the dashboard every 30s and would otherwise burn the budget
        // before the user can click anything.
        await sub.register(rateLimit, {
          max: 60,
          timeWindow: '1 minute',
          allowList: (req) => req.method === 'GET' || req.method === 'HEAD',
        })
        await sub.register(submissionRoutes, { prefix: '/submissions' })
      })
      await api.register(adminRoutes, { prefix: '/admin' })
      await api.register(async (sub) => {
        // Backends directory: heartbeats from operators (Bearer-token auth,
        // ~1/min per backend) and reads from CM (~1/min per client). Bump
        // the per-IP budget so a busy CM client doesn't exhaust it on
        // refresh.
        await sub.register(rateLimit, { max: 120, timeWindow: '1 minute' })
        await sub.register(backendsRoutes, { prefix: '/backends' })
      })
      await api.register(async (sub) => {
        await sub.register(rateLimit, { max: 30, timeWindow: '1 minute' })
        await sub.register(inviteRoutes, { prefix: '/' })
      })
      await api.register(publicRoutes, { prefix: '/' })
    },
    { prefix: '/api' }
  )

  // Static frontend (production). In dev, hit the Vite server directly.
  const frontendDist = join(__dirname, '..', '..', 'frontend', 'dist')
  if (existsSync(frontendDist)) {
    const inviteIndexTemplate = readFileSync(join(frontendDist, 'index.html'), 'utf8')

    app.get<{ Params: { code: string } }>('/j/:code', async (request, reply) => {
      const { code } = request.params
      const invite = isValidInviteCode(code) ? getInviteLink(code) : null
      let serverInfo: BeamMpServerInfo | null = null

      if (invite) {
        try {
          serverInfo = await fetchBeamMpServerInfo(invite.ip, invite.port, 'bmr-invite-unfurl/1.0')
        } catch (err) {
          request.log.debug({ err, code }, 'invite-unfurl: live server lookup failed')
        }
      }

      const metadata = buildInviteSeoMetadata(code, invite, serverInfo)
      return reply
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(renderInviteIndexHtml(inviteIndexTemplate, metadata))
    })

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
