/**
 * /j/:code  — BeamMP Content Manager invite landing page.
 *
 * Flow:
 *  1. Resolve the short code → ip + port  (GET /api/invite/:code)
 *  2. Probe the live server               (GET /api/server-info?ip=…&port=…)
 *  3. Show a rich "join card" with server name, map, players, mods, and a
 *     prominent "Open in Content Manager" button that fires the
 *     beammp-cm://join?… deep link.
 *  4. If CM is not installed, a secondary button leads to the CM download page.
 *
 * Intentionally accessible without login so share links work for everyone.
 */
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Container,
  Divider,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { useParams, Link } from 'react-router-dom'

const CM_LOGO_URL = 'https://raw.githubusercontent.com/musanajam11/BeamNG-Content-Manager/main/build/icon.png'

// ── API shapes ────────────────────────────────────────────────────────────────

interface InviteResolve {
  ip: string
  port: number
}

interface ServerInfo {
  sname: string
  sdesc: string
  map: string
  players: string
  maxplayers: string
  modstotal: string
  modstotalsize: string
  location: string
  password: boolean
  official: boolean
  featured: boolean
  tags: string
}

interface MapThumbResponse {
  thumbnail: string
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function resolveCode(code: string): Promise<InviteResolve> {
  const res = await fetch(`/api/invite/${encodeURIComponent(code)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error === 'not_found' ? 'invite_expired' : 'resolve_failed')
  }
  return res.json() as Promise<InviteResolve>
}

async function fetchServerInfo(ip: string, port: number): Promise<ServerInfo | null> {
  const res = await fetch(`/api/server-info?ip=${encodeURIComponent(ip)}&port=${port}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error('probe_failed')
  return res.json() as Promise<ServerInfo>
}

async function fetchMapThumbnail(mapPath: string): Promise<string | null> {
  const res = await fetch(`/api/invite/map-thumbnail?map=${encodeURIComponent(mapPath)}`)
  if (res.status === 404) return null
  if (!res.ok) return null
  const data = await res.json() as MapThumbResponse
  return data.thumbnail ?? null
}

function buildDeepLink(ip: string, port: number): string {
  return `beammp-cm://join?ip=${encodeURIComponent(ip)}&port=${port}`
}

function formatSize(bytes: string): string {
  const n = Number(bytes)
  if (isNaN(n) || n === 0) return '0 B'
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function humanizeMapName(raw: string | null | undefined): string {
  const input = String(raw ?? '').trim()
  if (!input) return 'Unknown'

  // BeamMP often sends map as /levels/<slug>/info.json style paths.
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
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function mapSlug(raw: string | null | undefined): string {
  const input = String(raw ?? '').trim()
  if (!input) return 'unknown'
  const m = input.match(/\/levels\/([^/]+)/i)
  const slug = m?.[1] ?? input.split('/').filter(Boolean).at(-1) ?? input
  return slug.replace(/\.[a-z0-9]+$/i, '').toLowerCase()
}

type BeamStyleState = {
  color?: string
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
}

const BEAM_COLORS: Record<string, string> = {
  '0': '#0b0b0b',
  '1': '#3669c9',
  '2': '#2e8f4d',
  '3': '#37a6a2',
  '4': '#c44747',
  '5': '#9b59b6',
  '6': '#d9a441',
  '7': '#c6c6c6',
  '8': '#8b8b8b',
  '9': '#6aa8ff',
  a: '#65d87b',
  b: '#53d9e3',
  c: '#ff7171',
  d: '#e59bff',
  e: '#ffd95a',
  f: '#f4f6fb',
}

function beamStyleToCss(s: BeamStyleState): React.CSSProperties {
  return {
    color: s.color,
    fontWeight: s.bold ? 700 : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: [
      s.underline ? 'underline' : '',
      s.strike ? 'line-through' : '',
    ].filter(Boolean).join(' ') || undefined,
  }
}

function renderBeamFormatted(input: string | null | undefined): React.ReactNode {
  const text = String(input ?? '')
  const nodes: React.ReactNode[] = []
  const style: BeamStyleState = {
    color: undefined,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
  }
  let buf = ''
  let idx = 0
  let key = 0

  const flush = () => {
    if (!buf) return
    nodes.push(
      <span key={key++} style={beamStyleToCss(style)}>
        {buf}
      </span>
    )
    buf = ''
  }

  while (idx < text.length) {
    const ch = text[idx]
    const nextChar = text[idx + 1]
    if (ch !== '^' || nextChar === undefined) {
      buf += ch
      idx += 1
      continue
    }

    const code = nextChar.toLowerCase()

    if (code in BEAM_COLORS) {
      flush()
      style.color = BEAM_COLORS[code]
      idx += 2
      continue
    }

    if (code === 'l' || code === 'o' || code === 'n' || code === 'm' || code === 'r') {
      flush()
      if (code === 'l') style.bold = true
      if (code === 'o') style.italic = true
      if (code === 'n') style.underline = true
      if (code === 'm') style.strike = true
      if (code === 'r') {
        style.color = undefined
        style.bold = false
        style.italic = false
        style.underline = false
        style.strike = false
      }
      idx += 2
      continue
    }

    // Unknown code: keep literal caret so we don't hide unexpected content.
    buf += '^'
    idx += 1
  }

  flush()
  return nodes.length > 0 ? nodes : text
}

// ── component ─────────────────────────────────────────────────────────────────

export function JoinPage() {
  const { code } = useParams<{ code: string }>()

  const resolveQ = useQuery({
    queryKey: ['invite', code],
    queryFn: () => resolveCode(code!),
    enabled: !!code,
    retry: false,
  })

  const serverQ = useQuery({
    queryKey: ['server-info', resolveQ.data?.ip, resolveQ.data?.port],
    queryFn: () => fetchServerInfo(resolveQ.data!.ip, resolveQ.data!.port),
    enabled: !!resolveQ.data,
    retry: false,
  })

  const thumbQ = useQuery({
    queryKey: ['invite-map-thumb', serverQ.data?.map],
    queryFn: () => fetchMapThumbnail(serverQ.data!.map),
    enabled: !!serverQ.data?.map,
    retry: false,
  })

  // ── error: code expired / not found ────────────────────────────────────────
  if (resolveQ.isError) {
    const expired = resolveQ.error instanceof Error && resolveQ.error.message === 'invite_expired'
    return (
      <div className="auth-bg">
        <Container size="xs" w="100%">
          <Paper withBorder p="xl" radius="md" shadow="sm">
            <Stack align="center" gap="md">
              <ThemeIcon size={56} radius="xl" color="red" variant="light">
                <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </ThemeIcon>
              <Title order={3}>{expired ? 'Invite link expired' : 'Invalid invite link'}</Title>
              <Text c="dimmed" ta="center" size="sm">
                {expired
                  ? 'This invite link is more than 7 days old. Ask the server owner to generate a new one.'
                  : 'This invite link is invalid or has already been used.'}
              </Text>
              <Button component={Link} to="/content-manager" variant="light" size="sm" fullWidth>
                Get Content Manager
              </Button>
              <BottomLinks />
            </Stack>
          </Paper>
        </Container>
      </div>
    )
  }

  // ── loading ─────────────────────────────────────────────────────────────────
  if (resolveQ.isPending) {
    return (
      <div className="auth-bg">
        <Container size="xs" w="100%">
          <Paper withBorder p="xl" radius="md" shadow="sm">
            <Stack align="center" gap="sm">
              <Loader size="lg" />
              <Text c="dimmed" size="sm">Loading invite...</Text>
              <BottomLinks />
            </Stack>
          </Paper>
        </Container>
      </div>
    )
  }

  const { ip, port } = resolveQ.data
  const server = serverQ.data
  const previewSrc = thumbQ.data ?? null
  const deepLink = buildDeepLink(ip, port)

  // ── main card ───────────────────────────────────────────────────────────────
  return (
    <div className="auth-bg">
      <Container size="sm" py="xl" w="100%">
        <Stack gap="lg">

          {/* Server card */}
          <Paper withBorder p="xl" radius="md" shadow="sm">
            <Stack gap="md">

              {previewSrc ? (
                <Box
                  style={{
                    borderRadius: 10,
                    overflow: 'hidden',
                    border: '1px solid rgba(255,255,255,0.08)',
                    maxHeight: 170,
                  }}
                >
                  <img
                    src={previewSrc}
                    alt={humanizeMapName(server?.map)}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                </Box>
              ) : (
                <Box
                  className="map-preview-fallback"
                  role="img"
                  aria-label={`${humanizeMapName(server?.map)} map preview unavailable`}
                >
                  <div className="map-preview-sun" aria-hidden="true" />
                  <div className="map-preview-road" aria-hidden="true" />
                  <div className="map-preview-grid" aria-hidden="true" />
                  <div className="map-preview-centerline" aria-hidden="true" />
                  <div className="map-preview-cacti" aria-hidden="true">
                    <div className="map-preview-cactus map-preview-cactus-right" />
                  </div>
                  <div className="map-preview-rails" aria-hidden="true" />
                  <div className="map-preview-glow" aria-hidden="true" />
                  <div className="map-preview-label-wrap">
                    <Text className="map-preview-label">{humanizeMapName(server?.map)}</Text>
                    <Text className="map-preview-sub">No screenshot available</Text>
                    <Text className="map-preview-slug">{mapSlug(server?.map)}</Text>
                  </div>
                </Box>
              )}

              {/* Server name + badges */}
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                  <Title order={3} style={{ wordBreak: 'break-word' }}>
                    {serverQ.isPending
                      ? <Text span c="dimmed" fw={400} size="lg">Loading server info…</Text>
                      : server
                        ? renderBeamFormatted(server.sname)
                        : `${ip}:${port}`}
                  </Title>
                  {server?.sdesc && (
                    <Text size="sm" c="dimmed" lineClamp={2}>{renderBeamFormatted(server.sdesc)}</Text>
                  )}
                </Stack>
                {server && (
                  <Stack gap={4} align="flex-end">
                    {server.official && <Badge color="blue" variant="light" size="sm">Official</Badge>}
                    {server.featured && <Badge color="yellow" variant="light" size="sm">Featured</Badge>}
                    {server.password && <Badge color="red" variant="light" size="sm">Password</Badge>}
                  </Stack>
                )}
              </Group>

              <Divider />

              {/* Stats grid */}
              {serverQ.isPending ? (
                <Group justify="center"><Loader size="sm" /></Group>
              ) : server ? (
                <Box
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                    gap: 12,
                  }}
                >
                  <StatPill label="Players" value={`${server.players} / ${server.maxplayers}`} />
                  <StatPill label="Map" value={humanizeMapName(server.map)} />
                  <StatPill label="Mods" value={`${server.modstotal} (${formatSize(server.modstotalsize)})`} />
                  {server.location && <StatPill label="Location" value={server.location} />}
                </Box>
              ) : (
                <Alert color="orange" radius="md">
                  Server appears to be offline — you can still try to open it in CM.
                </Alert>
              )}

              {/* Tags */}
              {server?.tags && (
                <Group gap={6}>
                  {server.tags.split(',').filter(Boolean).map((t) => (
                    <Badge key={t} variant="outline" color="gray" size="xs">{t.trim()}</Badge>
                  ))}
                </Group>
              )}

              {/* Address */}
              <Text size="xs" c="dimmed" ff="monospace">{ip}:{port}</Text>

              <Divider />

              {/* CTA */}
              <Stack gap="xs">
                <Button
                  component="a"
                  href={deepLink}
                  size="lg"
                  fullWidth
                  leftSection={
                    <img src={CM_LOGO_URL} alt="" width={20} height={20} style={{ borderRadius: 4 }} />
                  }
                >
                  Open in Content Manager
                </Button>
                <Text size="xs" c="dimmed" ta="center">
                  Don't have Content Manager?{' '}
                  <Anchor component={Link} to="/content-manager" size="xs">
                    Download it here
                  </Anchor>
                </Text>
              </Stack>

              <BottomLinks />

            </Stack>
          </Paper>

        </Stack>
      </Container>
    </div>
  )
}

function BottomLinks() {
  return (
    <Group justify="center" gap="xl" mt="xs">
      <Anchor
        component={Link}
        to="/registry"
        c="dimmed"
        size="xs"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
      >
        <img src="/app-icon.png" alt="Registry Browser" width={16} height={16} style={{ borderRadius: 4, display: 'block' }} />
        <span>Registry Browser</span>
      </Anchor>
    </Group>
  )
}

// ── StatPill ──────────────────────────────────────────────────────────────────

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <Paper withBorder p="xs" radius="sm">
      <Stack gap={2}>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: 0.5 }}>{label}</Text>
        <Text size="sm" fw={500} lineClamp={1}>{value}</Text>
      </Stack>
    </Paper>
  )
}
