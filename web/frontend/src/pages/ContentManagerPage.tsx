import { useQuery } from '@tanstack/react-query'
import {
  Alert, Anchor, Badge, Button, Card, Code, Group, List, Loader, Paper,
  SimpleGrid, Stack, Text, ThemeIcon, Title,
} from '@mantine/core'
import { api } from '../api/client'

interface CMAsset {
  name: string
  size: number
  url: string
}

interface CMRelease {
  version: string
  html_url: string
  published_at: string
  assets: {
    windows?: CMAsset
    linux_appimage?: CMAsset
    linux_deb?: CMAsset
    macos?: CMAsset
  }
}

const REPO_URL = 'https://github.com/musanajam11/BeamNG-Content-Manager'
const RELEASES_URL = `${REPO_URL}/releases`
const DEMO_URL = 'https://musanajam11.github.io/BeamNG-Content-Manager/'
const ISSUES_URL = `${REPO_URL}/issues`
export const CM_LOGO_URL =
  'https://raw.githubusercontent.com/musanajam11/BeamNG-Content-Manager/main/build/icon.png'

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

interface DownloadCardProps {
  os: string
  /** simple-icons slug, e.g. 'windows11', 'linux', 'debian', 'apple'. */
  brand: string
  /** Hex (no #) for the rendered glyph. */
  brandColor: string
  asset?: CMAsset
  fallbackHref: string
  description: string
  hint?: string
}

function BrandLogo({ slug, color, size = 22 }: { slug: string; color: string; size?: number }) {
  // Microsoft asked simple-icons to remove the Windows marks, so the CDN
  // 404s for `windows`/`windows11`. Render the classic four-pane glyph
  // inline for Windows; fall back to the simple-icons CDN for everything
  // else (CSP already permits `img-src https:`).
  if (slug === 'windows11' || slug === 'windows') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ display: 'block' }}
      >
        <path
          fill={`#${color}`}
          d="M3 5.5 11 4.3v7.2H3V5.5Zm0 13L11 19.7v-7.2H3v6Zm9 1.4 9 1.3v-8.7h-9v7.4Zm0-16.5v7.4h9V2.1l-9 1.3Z"
        />
      </svg>
    )
  }
  return (
    <img
      src={`https://cdn.simpleicons.org/${slug}/${color}`}
      width={size}
      height={size}
      alt=""
      style={{ display: 'block' }}
    />
  )
}

function DownloadCard({ os, brand, brandColor, asset, fallbackHref, description, hint }: DownloadCardProps) {
  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <ThemeIcon variant="light" size="lg" radius="md" color="gray">
              <BrandLogo slug={brand} color={brandColor} size={22} />
            </ThemeIcon>
            <div>
              <Text fw={600}>{os}</Text>
              <Text size="xs" c="dimmed">{description}</Text>
            </div>
          </Group>
          {asset && <Badge variant="light">{formatBytes(asset.size)}</Badge>}
        </Group>
        {asset ? (
          <>
            <Button
              component="a"
              href={asset.url}
              target="_blank"
              rel="noopener noreferrer"
              fullWidth
              variant="filled"
            >
              Download
            </Button>
            <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>{asset.name}</Text>
          </>
        ) : (
          <Button
            component="a"
            href={fallbackHref}
            target="_blank"
            rel="noopener noreferrer"
            fullWidth
            variant="default"
          >
            View on GitHub
          </Button>
        )}
        {hint && <Text size="xs" c="dimmed">{hint}</Text>}
      </Stack>
    </Card>
  )
}

export function ContentManagerPage() {
  const release = useQuery({
    queryKey: ['content-manager', 'latest'],
    queryFn: () => api.get<{ release: CMRelease; cached: boolean }>('/content-manager/latest'),
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  })

  const r = release.data?.release
  const assets = r?.assets ?? {}

  return (
    <Stack gap="lg">
      <div>
        <Group gap="md" align="center" mb={4} wrap="nowrap">
          <img
            src={CM_LOGO_URL}
            alt=""
            width={56}
            height={56}
            style={{ borderRadius: 10, display: 'block', flexShrink: 0 }}
          />
          <div>
            <Group gap="sm" align="center">
              <Title order={2}>BeamNG Content Manager</Title>
              {r && <Badge color="teal" variant="light">{r.version}</Badge>}
            </Group>
            <Text c="dimmed" size="sm">
              The all-in-one desktop manager for BeamNG.drive and BeamMP — manage mods,
              vehicles, maps, servers, friends, career saves, and more from a single app.
            </Text>
          </div>
        </Group>
      </div>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="xs">How it integrates with this registry</Title>
        <Text size="sm" mb="sm">
          Content Manager talks to this registry as one of its mod sources. When a
          mod is approved here and merged into the public index, CM picks it up
          automatically — users get an in-app update prompt, can browse the full
          catalog with thumbnails and metadata, and install or uninstall mods with
          one click without ever opening a browser.
        </Text>
        <List size="sm" spacing={4}>
          <List.Item>
            <strong>Registry update banner</strong> — CM polls this registry and
            surfaces new approvals as a dashboard notification.
          </List.Item>
          <List.Item>
            <strong>One-click install</strong> — downloads the asset linked in the
            registry entry, validates it, and drops it into the BeamNG mods folder.
          </List.Item>
          <List.Item>
            <strong>Uninstall on hover</strong> — already-installed registry mods
            show an uninstall affordance directly from the browse view.
          </List.Item>
          <List.Item>
            <strong>Submit feedback loop</strong> — CM can deep-link back here to
            this submission flow when a user wants to publish their own mod.
          </List.Item>
          <List.Item>
            <strong>Game-version gating</strong> — warns or blocks installs that
            target a different BeamNG.drive build than the one you have.
          </List.Item>
          <List.Item>
            <strong>Dependency &amp; conflict resolution</strong> — resolves the
            graph up-front and refuses pairs that would clobber the same JBeam slot.
          </List.Item>
          <List.Item>
            <strong>Hash-verified downloads</strong> — every asset is SHA-256
            checked before activation, so corrupted zips never reach the game.
          </List.Item>
          <List.Item>
            <strong>Manifest-tracked uninstall</strong> — staged installs and
            atomic activation mean uninstall removes only that mod's files, no
            leftover textures.
          </List.Item>
          <List.Item>
            <strong>Channel-aware updates &amp; rollback</strong> — pin
            stable/beta per mod; one-click revert to the previous working version.
          </List.Item>
          <List.Item>
            <strong>Profiles &amp; BeamMP server matching</strong> — toggle whole
            mod sets per profile, and bulk-install the exact versions a server
            requires before joining.
          </List.Item>
          <List.Item>
            <strong>Health check &amp; repair</strong> — validates installed mods
            against their manifests and re-installs anything that's drifted.
          </List.Item>
        </List>
        <Text size="xs" c="dimmed" mt="sm">
          The more metadata reviewers capture in a submission here (game version,
          dependencies, conflicts, hashes), the stronger every one of those
          guarantees becomes downstream in CM.
        </Text>
      </Paper>

      <div>
        <Title order={4} mb="xs">Downloads</Title>
        {release.isLoading && <Loader size="sm" />}
        {release.isError && (
          <Alert color="yellow" mb="sm">
            Couldn't reach the GitHub release API right now. You can still grab the
            latest builds directly from the{' '}
            <Anchor href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
              releases page
            </Anchor>.
          </Alert>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
          <DownloadCard
            os="Windows"
            brand="windows11"
            brandColor="0078D4"
            asset={assets.windows}
            fallbackHref={RELEASES_URL}
            description="NSIS installer · auto-updates"
            hint="SmartScreen may warn — click More info → Run anyway."
          />
          <DownloadCard
            os="Linux (AppImage)"
            brand="linux"
            brandColor="FCC624"
            asset={assets.linux_appimage}
            fallbackHref={RELEASES_URL}
            description="Portable, no install needed"
            hint="chmod +x then run."
          />
          <DownloadCard
            os="Linux (Debian/Ubuntu)"
            brand="debian"
            brandColor="A81D33"
            asset={assets.linux_deb}
            fallbackHref={RELEASES_URL}
            description=".deb package"
            hint="sudo dpkg -i <file>.deb"
          />
          <DownloadCard
            os="macOS"
            brand="apple"
            brandColor="A2AAAD"
            asset={assets.macos}
            fallbackHref={RELEASES_URL}
            description="DMG · drag to Applications"
            hint="Unsigned — right-click → Open the first time."
          />
        </SimpleGrid>
        {r && (
          <Text size="xs" c="dimmed" mt="xs">
            Released {new Date(r.published_at).toLocaleDateString()} ·{' '}
            <Anchor href={r.html_url} target="_blank" rel="noopener noreferrer">
              release notes
            </Anchor>
          </Text>
        )}
      </div>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="xs">What's inside</Title>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          <Text size="sm">🚗 Vehicle, map, and mod browsers with thumbnails</Text>
          <Text size="sm">🌐 BeamMP server browser with favorites + recents</Text>
          <Text size="sm">🛠 Self-hosted BeamMP server manager (8 tabs)</Text>
          <Text size="sm">🎙 WebRTC voice chat with spatial audio</Text>
          <Text size="sm">🎨 Livery editor (fabric.js canvas + decals)</Text>
          <Text size="sm">🧭 Live GPS overlay with route / POI / multiplayer</Text>
          <Text size="sm">🕹 Controls + force-feedback editor with presets</Text>
          <Text size="sm">🤝 Friends system + Discord Rich Presence</Text>
          <Text size="sm">💾 CareerMP / RLS save manager</Text>
          <Text size="sm">🌍 Coop World Editor — no BeamMP server needed</Text>
          <Text size="sm">📰 News feed (Steam + BeamMP)</Text>
          <Text size="sm">🌐 23-language i18n + custom theming</Text>
        </SimpleGrid>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="xs">Other links</Title>
        <Group gap="sm">
          <Button
            component="a"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="default"
          >
            Source on GitHub
          </Button>
          <Button
            component="a"
            href={DEMO_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="default"
          >
            Try the web demo
          </Button>
          <Button
            component="a"
            href={ISSUES_URL}
            target="_blank"
            rel="noopener noreferrer"
            variant="default"
          >
            Report an issue
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt="sm">
          Open source under <Code>GPL-3.0</Code>. Not affiliated with, endorsed by,
          or sponsored by BeamNG GmbH or the BeamMP team.
        </Text>
      </Paper>
    </Stack>
  )
}
