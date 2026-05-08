/**
 * Frequently asked questions page.
 *
 * Public-facing explainer covering what the registry is, how the
 * auto-update flow actually works, the two submission paths (manual +
 * auto-tracking via $kref), the trust/verification model, the metadata
 * fields users see in the form, and the safety restrictions on
 * downloads. Content is fact-checked against the actual implementation
 * (schema/, scripts/inflate.mjs, web/backend/src/submissions/*); keep
 * it in sync when behaviour changes.
 */
import {
  Accordion, Anchor, Badge, Box, Code, Container, Divider, Group, Image, List, Paper,
  SimpleGrid, Stack, Table, Text, ThemeIcon, Title,
} from '@mantine/core'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { DiscordLink, DISCORD_INVITE_URL } from '../components/DiscordLink'

const CM_REPO_URL = 'https://github.com/musanajam11/BeamNG-Content-Manager'
const CM_SERVER_OVERVIEW_IMAGE = 'https://raw.githubusercontent.com/musanajam11/BeamNG-Content-Manager/main/docs/screenshots/Servers-overview.jpg'
const CM_SERVER_CONFIG_IMAGE = 'https://raw.githubusercontent.com/musanajam11/BeamNG-Content-Manager/main/docs/screenshots/Servers-server-config.jpg'
const CM_SERVER_MODS_IMAGE = 'https://raw.githubusercontent.com/musanajam11/BeamNG-Content-Manager/main/docs/screenshots/Servers-mods.jpg'
const CM_CAREER_IMAGE = 'https://raw.githubusercontent.com/musanajam11/BeamNG-Content-Manager/main/docs/screenshots/CareerMP-Mods.jpg'

type Tier = 'green' | 'yellow' | 'red'

const TIER_COLOR: Record<Tier, string> = {
  green: 'var(--mantine-color-green-6)',
  yellow: 'var(--mantine-color-yellow-6)',
  red: 'var(--mantine-color-red-6)',
}

function TierDot({ tier }: { tier: Tier }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        backgroundColor: TIER_COLOR[tier],
        boxShadow: `0 0 0 2px color-mix(in srgb, ${TIER_COLOR[tier]} 25%, transparent)`,
        flexShrink: 0,
      }}
    />
  )
}

function TierRow({ tier, label, children }: { tier: Tier; label: string; children: React.ReactNode }) {
  return (
    <Group gap="xs" align="flex-start" wrap="nowrap">
      <div style={{ paddingTop: 6 }}><TierDot tier={tier} /></div>
      <div>
        <Text fw={600} component="span">{label}</Text>
        <Text size="sm">{children}</Text>
      </div>
    </Group>
  )
}

/** Visual: one stage in the submission journey. */
function FlowStage({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <Stack gap="xs">
      <Group gap="xs" align="center">
        <ThemeIcon
          size={26}
          radius="xl"
          variant="gradient"
          gradient={{ from: 'blue', to: 'cyan', deg: 135 }}
        >
          <Text size="xs" fw={700} c="white">{step}</Text>
        </ThemeIcon>
        <Text fw={600}>{title}</Text>
      </Group>
      <Box pl={36}>{children}</Box>
    </Stack>
  )
}

function GuideImage({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <Paper withBorder p="xs" radius="md">
      <Image src={src} alt={alt} radius="sm" />
      <Text size="xs" c="dimmed" mt="xs">{caption}</Text>
    </Paper>
  )
}

function BeamMpServerGuideAnswer() {
  return (
    <Stack gap="md">
      <Box id="beammp-server-guide" />
      <Text size="sm" c="dimmed">
        Use this if you want a normal self-hosted BeamMP server first, then layer
        mods or CareerMP on top of it later.
      </Text>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <GuideImage
          src={CM_SERVER_OVERVIEW_IMAGE}
          alt="BeamNG Content Manager self-hosted server overview"
          caption="Server Manager overview from the CM repo. The app manages multiple self-hosted BeamMP instances in one place."
        />
        <GuideImage
          src={CM_SERVER_CONFIG_IMAGE}
          alt="BeamNG Content Manager server config editor"
          caption="CM ships a typed config editor for the BeamMP server config instead of making you hand-edit TOML."
        />
      </SimpleGrid>

      <List type="ordered" spacing="sm" size="sm" withPadding>
        <List.Item>
          <strong>Install BeamNG Content Manager and finish its setup.</strong> CM has a
          dedicated self-hosted <strong>Server Manager</strong> surface. Its setup wizard also
          supports a server-manager mode where BeamMP server binaries can be downloaded on demand.
        </List.Item>
        <List.Item>
          <strong>Open Server Manager and create or select a server instance.</strong> The CM
          README documents instance management for self-hosted servers, including create,
          duplicate, rename, and delete.
        </List.Item>
        <List.Item>
          <strong>Make sure CM has access to a BeamMP server executable.</strong> If CM reports
          that the BeamMP server binary is missing, let it auto-download the correct binary or
          set a custom server executable path in CM settings.
        </List.Item>
        <List.Item>
          <strong>Use CM&apos;s Tailscale integration for friend-hosted sessions without manual router port forwarding.</strong>
          CM can integrate with Tailscale so your self-hosted friends server can run over seamless
          peer-to-peer networking when direct port forwarding is not available.
        </List.Item>
        <List.Item>
          <strong>Fill out the server configuration in CM.</strong> The Server Manager includes a
          config editor for core BeamMP settings such as server name, map, ports, max players,
          and auth-related values. CM refreshes the config before launch.
        </List.Item>
        <List.Item>
          <strong>Deploy client mods through the Mods panel when needed.</strong> CM&apos;s Server
          Manager exposes a mods panel for the server&apos;s <Code>Resources/Client</Code>
          directory. Use that for BeamNG zip mods that players should receive when they join.
        </List.Item>
        <List.Item>
          <strong>Use the File Manager for server-side resources and manual checks.</strong>
          CM&apos;s File Manager can browse and edit the server tree in-app, which is the safer
          place to verify folders like <Code>Resources/Server</Code> when a server plugin needs
          extra files beyond a normal client zip.
        </List.Item>
        <List.Item>
          <strong>Start the server and watch the live console.</strong> CM exposes status, live
          console streaming, logs, and restart scheduling inside Server Manager, so verify that
          the instance fully boots before inviting players.
        </List.Item>
      </List>

      <GuideImage
        src={CM_SERVER_MODS_IMAGE}
        alt="BeamNG Content Manager server mods panel"
        caption="The Mods panel documented in the CM README is the right place for BeamMP client-distributed zip mods."
      />

      <Text size="sm" c="dimmed">
        After the base server is stable, use the{' '}
        <Anchor component={Link} to="/registry">registry browser</Anchor> to find
        BeamMP-compatible mods, then deploy only the zips your server actually needs.
      </Text>

      <Text size="sm" c="dimmed">
        Source trail:{' '}
        <Anchor href={CM_REPO_URL} target="_blank" rel="noreferrer">
          BeamNG Content Manager GitHub repo
        </Anchor>
        .
      </Text>
    </Stack>
  )
}

function CareerMpServerGuideAnswer() {
  return (
    <Stack gap="md">
      <Box id="careermp-server-guide" />
      <Text size="sm" c="dimmed">
        This covers the base CareerMP stack only. It does not assume RLS, Better Career,
        Great Rebalance, or other compatibility stacks.
      </Text>

      <GuideImage
        src={CM_CAREER_IMAGE}
        alt="BeamNG Content Manager CareerMP tools"
        caption="CM includes a dedicated CareerMP area and server-target selection, not just a generic file browser."
      />

      <List type="ordered" spacing="sm" size="sm" withPadding>
        <List.Item>
          <strong>Start from a working BeamMP server instance in CM.</strong> CareerMP is an
          add-on for BeamMP, not a replacement for the base server manager flow above.
        </List.Item>
        <List.Item>
          <strong>Pick the server target inside CM&apos;s CareerMP tools.</strong> The CM app has a
          server-target selector for CareerMP operations. It can target either a managed server
          instance or a custom server directory you browse to manually.
        </List.Item>
        <List.Item>
          <strong>Install the base CareerMP release into that server.</strong> The upstream
          CareerMP readme bundled with CM states that you unpack the release into the root of
          the BeamMP server directory.
        </List.Item>
        <List.Item>
          <strong>Set the two required BeamMP values before launch.</strong> The verified
          CareerMP install notes require <Code>MaxCars = 100</Code> or greater and
          <Code>Map = "/levels/west_coast_usa/info.json"</Code> in the BeamMP server config.
        </List.Item>
        <List.Item>
          <strong>Start the server once and let CareerMP generate its own config.</strong> CM&apos;s
          CareerMP config editor is intentionally hidden until CareerMP is installed, and it
          shows a "missing config" notice until the server has run once and created
          <Code>Resources/Server/CareerMP/config/config.json</Code>.
        </List.Item>
        <List.Item>
          <strong>Return to CM and edit the generated CareerMP config.</strong> Once the config
          exists, CM can load and save it directly. The app writes changes back to
          <Code>Resources/Server/CareerMP/config/config.json</Code> for you.
        </List.Item>
        <List.Item>
          <strong>Use the live console for CareerMP-specific commands.</strong> The bundled
          CareerMP readme says you can type <Code>CareerMP Help</Code> in the server console to
          list CareerMP commands.
        </List.Item>
      </List>

      <Paper withBorder p="sm" radius="md" bg="var(--mantine-color-dark-7)">
        <Stack gap={4}>
          <Text size="sm" fw={600}>Verified constraints from the bundled CareerMP docs</Text>
          <List size="sm" spacing={4} withPadding>
            <List.Item>Base CareerMP currently targets West Coast, USA.</List.Item>
            <List.Item>CareerMP uses the BeamMP username to create or select the save by default.</List.Item>
            <List.Item>The config UI does not exist until the first server run has created the config file.</List.Item>
          </List>
        </Stack>
      </Paper>

      <Text size="sm" c="dimmed">
        If you want a second guide for <strong>RLS + CareerMP</strong> or <strong>Better Career + CareerMP</strong>,
        that should be documented separately. CM treats those as different install flows and ships
        different readmes and artifacts for them.
      </Text>

      <Text size="sm" c="dimmed">
        Source trail:{' '}
        <Anchor href={CM_REPO_URL} target="_blank" rel="noreferrer">
          BeamNG Content Manager GitHub repo
        </Anchor>
        .
      </Text>
    </Stack>
  )
}

/* ── SVG flowchart helpers ─────────────────────────────────────────── */

interface NodeRectProps {
  x: number
  y: number
  w: number
  h: number
  color: string
  title: string
  subtitle?: string
  emoji?: string
  kind?: 'rect' | 'pill' | 'diamond' | 'terminal'
}
function FlowNode({ x, y, w, h, color, title, subtitle, emoji, kind = 'rect' }: NodeRectProps) {
  const stroke = `var(--mantine-color-${color}-6)`
  const fill = `color-mix(in srgb, var(--mantine-color-${color}-9) 35%, var(--mantine-color-dark-7))`
  const titleColor = `var(--mantine-color-${color}-2)`
  const cx = x + w / 2
  const cy = y + h / 2
  const titleY = subtitle ? cy - 4 : cy + 5
  let shape: React.ReactNode
  if (kind === 'diamond') {
    shape = (
      <polygon
        points={`${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`}
        fill={fill}
        stroke={stroke}
        strokeWidth={2}
      />
    )
  } else if (kind === 'pill' || kind === 'terminal') {
    shape = (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={h / 2}
        ry={h / 2}
        fill={fill}
        stroke={stroke}
        strokeWidth={kind === 'terminal' ? 3 : 2}
      />
    )
  } else {
    shape = (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        ry={10}
        fill={fill}
        stroke={stroke}
        strokeWidth={2}
      />
    )
  }
  return (
    <g>
      {shape}
      {emoji && (
        <text
          x={cx}
          y={cy - (subtitle ? 14 : 10)}
          textAnchor="middle"
          fontSize="18"
          dominantBaseline="middle"
        >
          {emoji}
        </text>
      )}
      <text
        x={cx}
        y={emoji ? titleY + 12 : titleY}
        textAnchor="middle"
        fontSize="13"
        fontWeight={700}
        fill={titleColor}
        dominantBaseline="middle"
      >
        {title}
      </text>
      {subtitle && (
        <text
          x={cx}
          y={emoji ? cy + 22 : cy + 12}
          textAnchor="middle"
          fontSize="10"
          fill="var(--mantine-color-dimmed)"
          dominantBaseline="middle"
        >
          {subtitle}
        </text>
      )}
    </g>
  )
}

function FlowEdge({
  d, color = 'gray', label, labelX, labelY, dashed,
}: {
  d: string
  color?: string
  label?: string
  labelX?: number
  labelY?: number
  dashed?: boolean
}) {
  const stroke = `var(--mantine-color-${color}-5)`
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeDasharray={dashed ? '6 4' : undefined}
        markerEnd={`url(#arrow-${color})`}
      />
      {label && labelX !== undefined && labelY !== undefined && (
        <g>
          <rect
            x={labelX - label.length * 3.4 - 6}
            y={labelY - 9}
            width={label.length * 6.8 + 12}
            height={18}
            rx={9}
            ry={9}
            fill="var(--mantine-color-dark-7)"
            stroke={stroke}
            strokeWidth={1}
          />
          <text
            x={labelX}
            y={labelY + 1}
            textAnchor="middle"
            fontSize="10"
            fontWeight={600}
            fill={`var(--mantine-color-${color}-3)`}
            dominantBaseline="middle"
          >
            {label}
          </text>
        </g>
      )}
    </g>
  )
}

function ArrowMarker({ color }: { color: string }) {
  return (
    <marker
      id={`arrow-${color}`}
      viewBox="0 0 10 10"
      refX="8"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={`var(--mantine-color-${color}-5)`} />
    </marker>
  )
}

/**
 * Hand-drawn SVG flowchart of the submission journey.
 * Branches: kind → review lane → decision → outcome (with resubmit loop and
 * publish chain). Themed via Mantine CSS variables so it tracks light/dark.
 */
function SubmissionFlowChart() {
  // viewBox 1040x1180 — preserveAspectRatio scales it to container width
  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      style={{
        background: 'var(--mantine-color-dark-8)',
        overflow: 'hidden',
      }}
    >
      <svg
        viewBox="0 0 1040 1180"
        width="100%"
        height="auto"
        role="img"
        aria-label="Submission flow chart"
        style={{ display: 'block', fontFamily: 'inherit' }}
      >
        <defs>
          <ArrowMarker color="gray" />
          <ArrowMarker color="blue" />
          <ArrowMarker color="green" />
          <ArrowMarker color="yellow" />
          <ArrowMarker color="red" />
          <ArrowMarker color="grape" />
          <ArrowMarker color="teal" />
        </defs>

        {/* Start */}
        <FlowNode kind="terminal" x={400} y={20} w={240} h={60} color="blue"
          emoji="✍️" title="You submit a mod or edit" />

        {/* Edge: start -> kinds (manifold) */}
        <FlowEdge d="M 520 80 L 520 110" color="blue" />
        <FlowEdge d="M 520 110 L 130 110 L 130 145" color="blue" />
        <FlowEdge d="M 520 110 L 380 110 L 380 145" color="blue" />
        <FlowEdge d="M 520 110 L 660 110 L 660 145" color="blue" />
        <FlowEdge d="M 520 110 L 910 110 L 910 145" color="blue" />

        {/* Row: kinds */}
        <FlowNode x={50}  y={145} w={160} h={70} color="cyan"   emoji="🆕" title="New mod" subtitle="brand-new identifier" />
        <FlowNode x={300} y={145} w={160} h={70} color="indigo" emoji="✏️" title="Edit / new version" subtitle="existing mod" />
        <FlowNode x={580} y={145} w={160} h={70} color="grape"  emoji="🪪" title="Claim ownership" subtitle="prove authorship" />
        <FlowNode x={830} y={145} w={160} h={70} color="orange" emoji="🗑️" title="Delete" subtitle="owner / admin only" />

        {/* Edges: kinds -> Decision 1 */}
        <FlowEdge d="M 130 215 L 130 270 L 460 270" color="gray" />
        <FlowEdge d="M 380 215 L 380 270 L 460 270" color="gray" />
        <FlowEdge d="M 660 215 L 660 270 L 580 270" color="gray" />
        <FlowEdge d="M 910 215 L 910 270 L 580 270" color="gray" />

        {/* Decision 1: Who reviews? */}
        <FlowNode kind="diamond" x={400} y={235} w={240} h={90} color="yellow"
          title="Who reviews this?" subtitle="depends on ownership + trust" />

        {/* Edges from Decision 1 to lanes */}
        <FlowEdge
          d="M 460 295 L 200 295 L 200 360"
          color="green"
          label="Trusted, own mod"
          labelX={300}
          labelY={285}
        />
        <FlowEdge
          d="M 520 325 L 520 360"
          color="blue"
          label="New mod / claim / unowned"
          labelX={520}
          labelY={345}
        />
        <FlowEdge
          d="M 580 295 L 840 295 L 840 360"
          color="grape"
          label="Edit to claimed mod"
          labelX={760}
          labelY={285}
        />

        {/* Row: review lanes */}
        <FlowNode x={100} y={360} w={200} h={84} color="green"
          emoji="⚡" title="Auto-approved" subtitle="skips the queue" />
        <FlowNode x={420} y={360} w={200} h={84} color="blue"
          emoji="👥" title="Reviewer queue" subtitle="admins + trusted users" />
        <FlowNode x={740} y={360} w={200} h={84} color="grape"
          emoji="👑" title="Owner queue" subtitle="the mod's owner decides" />

        {/* Reviewer + Owner -> Decision 2 */}
        <FlowEdge d="M 520 444 L 520 490" color="blue" />
        <FlowEdge d="M 840 444 L 840 470 L 580 470 L 580 490" color="grape" />

        {/* Auto-approved bypass: long edge straight down to LIVE */}
        <FlowEdge
          d="M 200 444 L 200 1005 L 380 1005"
          color="green"
          dashed
          label="straight to publish"
          labelX={200}
          labelY={760}
        />

        {/* Decision 2: Reviewer decides */}
        <FlowNode kind="diamond" x={400} y={490} w={240} h={90} color="yellow"
          title="Reviewer decides" subtitle="approve · changes · reject" />

        {/* Edges to outcomes */}
        <FlowEdge
          d="M 460 550 L 200 550 L 200 615"
          color="green"
          label="approve"
          labelX={300}
          labelY={540}
        />
        <FlowEdge
          d="M 520 580 L 520 615"
          color="yellow"
          label="changes"
          labelX={520}
          labelY={600}
        />
        <FlowEdge
          d="M 580 550 L 840 550 L 840 615"
          color="red"
          label="reject"
          labelX={760}
          labelY={540}
        />

        {/* Row: outcomes */}
        <FlowNode x={100} y={615} w={200} h={84} color="green"
          emoji="✓" title="Approved" subtitle="status: queued" />
        <FlowNode x={420} y={615} w={200} h={84} color="yellow"
          emoji="↺" title="Changes requested" subtitle="reviewer left a note" />
        <FlowNode x={740} y={615} w={200} h={84} color="red"
          emoji="✕" title="Rejected" subtitle="this submission is final" />

        {/* Loop: Changes requested → resubmit → back to start */}
        <FlowEdge
          d="M 620 657 C 990 657, 1020 50, 640 50"
          color="yellow"
          dashed
          label="you fix + resubmit"
          labelX={1000}
          labelY={360}
        />

        {/* Rejected → terminal note */}
        <FlowEdge
          d="M 840 699 L 840 750"
          color="red"
        />
        <FlowNode kind="pill" x={720} y={750} w={240} h={50} color="red"
          title="Submit a new one if you fixed it" />

        {/* Approved → Pipeline */}
        <FlowEdge d="M 200 699 L 200 730 L 420 730" color="teal" />

        {/* Pipeline */}
        <FlowNode x={420} y={730} w={200} h={70} color="teal"
          emoji="⚙️" title="Pipeline runs" subtitle="git commit + push" />

        {/* Pipeline → PR */}
        <FlowEdge d="M 520 800 L 520 850" color="teal" />

        {/* PR opened */}
        <FlowNode x={420} y={850} w={200} h={70} color="teal"
          emoji="🔀" title="Pull request opened" subtitle="status: pr_opened" />

        {/* PR → Live */}
        <FlowEdge
          d="M 520 920 L 520 970"
          color="teal"
          label="merged"
          labelX={520}
          labelY={945}
        />

        {/* LIVE */}
        <FlowNode kind="terminal" x={380} y={970} w={280} h={70} color="green"
          emoji="🌐" title="Live in the registry" subtitle="indexed on next CI build" />

      </svg>
    </Paper>
  )
}

type Item = { value: string; question: string; answer: React.ReactNode }

const ITEMS: Item[] = [
  {
    value: 'what-is',
    question: 'What is the BeamNG Mod Registry?',
    answer: (
      <Stack gap="xs">
        <Text>
          It is a community-curated <strong>metadata index</strong> for
          BeamNG.drive and BeamMP mods, modeled after the CKAN system used by
          Kerbal Space Program. Each entry is a small JSON file (a{' '}
          <Code>.beammod</Code>) that describes <em>where</em> a mod lives,
          what version is current, what kind of content it is, what it depends
          on, and how to verify the file (SHA-256 hash + size).
        </Text>
        <Text>
          The registry itself does <strong>not</strong> host any mod files.
          The author keeps full control of where the mod is hosted (BeamNG.com,
          GitHub releases, their own site, etc.). Think of it as a phone book:
          it points to the original source.
        </Text>
        <Text size="sm" c="dimmed">
          The full index is published as a single compressed JSON artifact to
          GitHub Releases on the registry repository. Compatible launchers
          download that artifact and use it to browse, install, update, and
          resolve dependencies.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'benefit',
    question: 'What is the benefit over just downloading mods manually?',
    answer: (
      <List spacing="xs" size="sm" withPadding>
        <List.Item>
          <strong>Auto-updates.</strong> Compatible launchers (e.g. BeamMP
          Content Manager) read the registry and notice when a mod has a new
          version, then download it for you.
        </List.Item>
        <List.Item>
          <strong>Integrity checks.</strong> Every entry can carry a SHA-256
          hash and expected file size, so a launcher verifies the downloaded
          file hasn&rsquo;t been tampered with or replaced.
        </List.Item>
        <List.Item>
          <strong>Dependencies resolved automatically.</strong> Entries declare
          required, recommended, suggested, and conflicting mods; the launcher
          can install the whole tree in one go.
        </List.Item>
        <List.Item>
          <strong>Single stable identifier.</strong> Mod packs and BeamMP
          servers can reference one identifier instead of hard-coded download
          links that break.
        </List.Item>
        <List.Item>
          <strong>Discoverability.</strong> Browse, search, and filter mods in
          one place rather than hunting forum threads.
        </List.Item>
      </List>
    ),
  },
  {
    value: 'auto-update',
    question: 'How do auto-updates actually work?',
    answer: (
      <Stack gap="xs">
        <Text>The flow is:</Text>
        <List type="ordered" spacing="xs" size="sm" withPadding>
          <List.Item>
            A registry entry stores the mod&rsquo;s current{' '}
            <Code>version</Code>, <Code>download</Code> URL, and{' '}
            <Code>download_hash.sha256</Code>.
          </List.Item>
          <List.Item>
            When the author releases a new version, the entry is updated —
            either <strong>automatically</strong> (if the entry has a{' '}
            <Code>$kref</Code> auto-tracking template) or <strong>manually</strong>{' '}
            via a new web submission.
          </List.Item>
          <List.Item>
            That update is committed to the registry repository, which triggers
            CI to rebuild and publish a new compressed index to GitHub
            Releases.
          </List.Item>
          <List.Item>
            Your launcher periodically fetches the latest index, compares the
            stored version against your installed version, and if there&rsquo;s
            a newer one, downloads it from the original URL and verifies the
            SHA-256 before installing.
          </List.Item>
        </List>
      </Stack>
    ),
  },
  {
    value: 'do-i-need-to-upload',
    question: 'Do I need to upload my mod here?',
    answer: (
      <Stack gap="xs">
        <Text>
          <strong>No.</strong> The mod file itself is never stored on this
          server. You submit metadata (name, version, download URL, hash, type,
          tags, dependencies, etc.) and the file stays on whatever host you
          already use.
        </Text>
        <Text size="sm" c="dimmed">
          You <em>can</em> upload your <Code>.zip</Code> on the submit page,
          but only so the server can read the archive&rsquo;s table of contents
          and pre-fill fields for you (file count, mod type detection, server
          vs client layout, suggested name from <Code>info.json</Code>).
          Nothing about that upload is kept after inspection.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'two-paths',
    question: 'Manual submit vs. auto-tracking — what\u2019s the difference?',
    answer: (
      <Stack gap="xs">
        <Text>There are two ways an entry can stay up to date:</Text>
        <List spacing="sm" size="sm" withPadding>
          <List.Item>
            <strong>Manual.</strong> You submit a fresh metadata entry every
            time you release a new version. Good if your mod doesn&rsquo;t
            live on GitHub or you only ship occasional releases.
          </List.Item>
          <List.Item>
            <strong>Auto-tracking (NetBeamMod).</strong> You submit a tiny
            template that points at a source — either a GitHub repo (
            <Code>#/github/owner/repo</Code>) or a BeamNG.com resource (
            <Code>#/beamng/12345</Code>). A scheduled job watches that source,
            and whenever a new release appears it automatically generates a
            new <Code>.beammod</Code> entry with the version, download URL,
            and freshly computed hash. You never have to touch the registry
            again.
          </List.Item>
        </List>
        <Text size="sm" c="dimmed">
          Auto-tracking templates support optional knobs:{' '}
          <Code>$filter_asset</Code> (regex to pick the right release asset),
          {' '}<Code>$version_strip_v</Code>,{' '}
          <Code>$version_transform</Code>,{' '}
          <Code>$include_prerelease</Code>, and{' '}
          <Code>$max_releases</Code>.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'should-i-submit',
    question: 'Should I submit my mod?',
    answer: (
      <Stack gap="xs">
        <Text>Submit if you want any of these:</Text>
        <List spacing={4} size="sm" withPadding>
          <List.Item>Players to get auto-updates when you release new versions.</List.Item>
          <List.Item>A stable, hash-verified link you can share or use in mod packs.</List.Item>
          <List.Item>Your mod listed in tools and servers that read the registry.</List.Item>
          <List.Item>Dependency resolution to handle prerequisites for you.</List.Item>
        </List>
        <Text size="sm" c="dimmed">
          If your mod is private, work-in-progress, or you don&rsquo;t want it
          redistributed via tooling, just don&rsquo;t submit it.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'who-can-submit',
    question: 'Who can submit a mod — does it have to be the author?',
    answer: (
      <Stack gap="xs">
        <Text>
          Anyone with an account can submit. Submitting an entry does{' '}
          <strong>not</strong> automatically make you the owner — even for
          a brand-new identifier no one has touched before.
        </Text>
        <Text>
          To become the owner of a mod (and thereby gate future edits to it
          behind your approval), you must explicitly use the{' '}
          <strong>Claim this mod</strong> button on the registry browser
          drawer. Claims are reviewed by an admin or green-tier reviewer
          before ownership is transferred. See{' '}
          <em>How does claiming and ownership work?</em> below for the full
          flow.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'claiming',
    question: 'How does claiming and ownership work?',
    answer: (
      <Stack gap="xs">
        <Text>
          Every mod entry can have <strong>at most one owner</strong>. Owners
          aren&rsquo;t assigned automatically by the act of editing or
          submitting — ownership only changes through the explicit claim
          flow:
        </Text>
        <List type="ordered" spacing={4} size="sm" withPadding>
          <List.Item>
            Open the mod in the registry browser and press{' '}
            <strong>Claim this mod</strong>.
          </List.Item>
          <List.Item>
            Add an optional message for the reviewer (links to the upstream
            page, your forum profile, etc.) and submit.
          </List.Item>
          <List.Item>
            The claim lands as a <Code>kind=&quot;claim&quot;</Code>{' '}
            submission with status <Code>pending_review</Code>. Admins and
            green-tier reviewers can see it; competing claims for the same
            mod are visible to reviewers so they can pick the right author.
          </List.Item>
          <List.Item>
            On approval, ownership transfers to you atomically. From then on,
            edits to the mod made by other users land in your{' '}
            <strong>owner queue</strong> for approval (see below) instead of
            the global review queue.
          </List.Item>
        </List>
        <Text size="sm" c="dimmed">
          Admins can transfer or revoke ownership at any time — useful for
          deceased accounts, abandoned mods, or disputes that go beyond what
          a green-tier reviewer should rule on.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'propose-edit',
    question: 'Can I edit someone else’s mod entry?',
    answer: (
      <Stack gap="xs">
        <Text>
          Yes. Open the mod in the registry browser and use{' '}
          <strong>Propose edit</strong> to suggest changes (better thumbnail,
          fixed download URL, missing tags, corrected metadata, etc.) or{' '}
          <strong>Submit new version</strong> if you&rsquo;re shipping a new
          release.
        </Text>
        <Text>
          Where the submission is routed depends on whether the mod is
          claimed:
        </Text>
        <List spacing={4} size="sm" withPadding>
          <List.Item>
            <strong>Claimed by someone else</strong> — routed directly to
            that owner&rsquo;s queue. Only the owner (or an admin) can
            approve.
          </List.Item>
          <List.Item>
            <strong>Unclaimed but already on disk</strong> — routed to the
            global review queue (admins / green-tier).
          </List.Item>
          <List.Item>
            <strong>Brand-new identifier</strong> — follows your trust tier
            (green: auto-queued; yellow: pending review).
          </List.Item>
        </List>
        <Text size="sm" c="dimmed">
          Propose edit / Submit new version require a signed-in account, but
          browsing and reading the registry does not.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'owner-queue',
    question: 'I own a mod — how do I review edits other people propose?',
    answer: (
      <Stack gap="xs">
        <Text>
          Owned mods get their own approval lane. When another user submits
          an edit or a new version of a mod you own, it lands in your{' '}
          <strong>owner queue</strong> (visible from the dashboard) instead
          of the global reviewer queue. You can approve, request changes, or
          reject the same way an admin does.
        </Text>
        <Text size="sm" c="dimmed">
          Submissions you make on your <em>own</em> mod still go through the
          normal trust-tier path — you don&rsquo;t need to approve yourself.
          Admins always retain a global override.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'ratings',
    question: 'How do mod ratings work?',
    answer: (
      <Stack gap="xs">
        <Text>
          Signed-in users can leave one 1–5 star rating per mod. Open the
          mod in the registry browser and use the rating widget in the
          drawer. Click an existing rating again or use the ✕ button to
          clear it.
        </Text>
        <Text size="sm" c="dimmed">
          Aggregates (average + count) are visible to everyone, including
          signed-out viewers. Ratings live in the registry database, not in
          the published index, so they don&rsquo;t affect launchers —
          they&rsquo;re purely a discovery aid for the web UI.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'public-browsing',
    question: 'Do I need an account to browse the registry?',
    answer: (
      <Stack gap="xs">
        <Text>
          No. The registry browser and this FAQ are publicly readable.
          Anyone can search, filter, open mod details, and view the average
          rating, owner, and edit history without signing in.
        </Text>
        <Text>
          Sign in is required for actions that change state: rating a mod,
          claiming a mod, proposing an edit, or submitting a new version.
          Disabled buttons in the browser show a “sign in to …” hint
          alongside them.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'submission-flow',
    question: 'Submission Flow — the visual map',
    answer: (
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          A bird&rsquo;s-eye flowchart of the journey from clicking{' '}
          <em>Submit</em> to your mod going live (or back to your inbox for
          fixes). Follow the arrows.
        </Text>
        <SubmissionFlowChart />
        <Group gap="xs" wrap="wrap">
          <Badge variant="light" color="green" leftSection="⚡">trusted shortcut</Badge>
          <Badge variant="light" color="blue" leftSection="👥">reviewer queue</Badge>
          <Badge variant="light" color="grape" leftSection="👑">owner queue</Badge>
          <Badge variant="light" color="yellow" leftSection="↺">resubmit loop</Badge>
          <Badge variant="light" color="red" leftSection="✕">rejected = final</Badge>
          <Badge variant="light" color="teal" leftSection="🌐">publish chain</Badge>
        </Group>
        <Paper withBorder p="sm" radius="md" bg="var(--mantine-color-dark-7)">
          <Stack gap={4}>
            <Text size="xs" c="dimmed" fw={600}>How to read it</Text>
            <Text size="xs">
              <strong>Solid arrows</strong> are the normal path.{' '}
              <strong>The dashed green arrow</strong> on the left is the
              shortcut for trusted users editing their own mod — it skips
              the queue and the publish pipeline isn&rsquo;t shown for that
              path because it runs the same way. The yellow loop on the
              right shows <em>changes requested</em> sending you back to
              fix and resubmit — your submission keeps the same review
              thread.
            </Text>
          </Stack>
        </Paper>
      </Stack>
    ),
  },
  {
    value: 'lifecycle',
    question: 'What happens after I hit submit?',
    answer: (
      <Stack gap="xs">
        <Text>Each submission goes through a series of states:</Text>
        <List spacing={4} size="sm" withPadding>
          <List.Item><strong>pending_review</strong> — waiting for an admin or green-tier reviewer. (Skipped if you&rsquo;re green-tier or admin.)</List.Item>
          <List.Item><strong>changes_requested</strong> — a reviewer asked for edits; you can update and resubmit.</List.Item>
          <List.Item><strong>queued</strong> — approved, waiting for the pipeline to run.</List.Item>
          <List.Item><strong>processing</strong> — pipeline is writing files into the registry repo and opening a pull request.</List.Item>
          <List.Item><strong>pr_opened</strong> — a PR has been opened on the registry repo; a background poller watches it.</List.Item>
          <List.Item><strong>merged</strong> — the PR was merged. Your entry is live; the index will rebuild on the next CI run.</List.Item>
          <List.Item><strong>rejected</strong> — the PR was closed without merging, or an admin rejected the submission outright.</List.Item>
          <List.Item><strong>failed</strong> — the pipeline hit an error (e.g. GitHub credentials misconfigured). Admins are notified.</List.Item>
        </List>
      </Stack>
    ),
  },
  {
    value: 'trust-tiers',
    question: 'What do the green / yellow / red dots next to my name mean?',
    answer: (
      <Stack gap="sm">
        <Text>
          That&rsquo;s your <strong>trust tier</strong>. It controls how your
          submissions are handled:
        </Text>
        <Stack gap="xs">
          <TierRow tier="green" label="Green — trusted">
            Your submissions skip the review queue and are sent straight to
            the pipeline (auto-approved). Green users can also access the
            review queue to help moderate other people&rsquo;s submissions.
          </TierRow>
          <TierRow tier="yellow" label="Yellow — standard (default)">
            Every new account starts here. Submissions land in{' '}
            <em>pending review</em> and are accepted once an admin or a
            green-tier reviewer approves them.
          </TierRow>
          <TierRow tier="red" label="Red — restricted">
            Submission permissions are stripped. Usually applied to accounts
            that have abused the system (spam, malicious links, repeat policy
            violations).
          </TierRow>
        </Stack>
        <Text size="sm" c="dimmed">
          Tiers are set by admins. Consistently helpful, accurate submissions
          are how you get promoted from yellow to green.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'verified',
    question: 'What does the "Verified" badge on a mod mean?',
    answer: (
      <Stack gap="xs">
        <Text>
          A Verified entry is one that was <strong>curated by a human</strong>{' '}
          rather than scraped automatically — either submitted through this
          web UI, or generated by an author-controlled auto-tracking template.
        </Text>
        <Text>
          It signals that the metadata (name, description, dependencies, type)
          was reviewed by a real person, and the version field is being kept
          current intentionally — not just inferred from a website scrape.
        </Text>
        <Text size="sm" c="dimmed">
          Internally this is the <Code>x_verified</Code> field in the{' '}
          <Code>.beammod</Code> file. Launchers typically display Verified
          entries with a badge and rank them above unverified ones in search
          results.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'url-restrictions',
    question: 'What URLs and files are accepted?',
    answer: (
      <Stack gap="xs">
        <Text>For safety, the submit form enforces several rules:</Text>
        <List spacing={4} size="sm" withPadding>
          <List.Item><strong>HTTPS only.</strong> Plain HTTP URLs are rejected.</List.Item>
          <List.Item>
            <strong>Allowlisted hosts.</strong> Downloads must come from{' '}
            <Code>github.com</Code>, <Code>githubusercontent.com</Code>,{' '}
            <Code>beamng.com</Code>, or <Code>beamng.gg</Code>. Other hosts
            are rejected to prevent the registry from pointing at sketchy
            mirrors.
          </List.Item>
          <List.Item>
            <strong>Executable extensions are blocked.</strong> The URL
            can&rsquo;t end in <Code>.exe</Code>, <Code>.msi</Code>,{' '}
            <Code>.bat</Code>, <Code>.cmd</Code>, <Code>.ps1</Code>,{' '}
            <Code>.vbs</Code>, <Code>.jar</Code>, <Code>.app</Code>,{' '}
            <Code>.dmg</Code>, <Code>.pkg</Code>, <Code>.deb</Code>,{' '}
            <Code>.rpm</Code>, <Code>.apk</Code>, <Code>.sh</Code>, or other
            installers/scripts. Mods must be archive files (typically{' '}
            <Code>.zip</Code>).
          </List.Item>
          <List.Item><strong>2 GiB cap.</strong> The server-side hash fetch will abort if the file exceeds 2 GiB.</List.Item>
        </List>
      </Stack>
    ),
  },
  {
    value: 'hashing',
    question: 'How does the hash get computed and verified?',
    answer: (
      <Stack gap="xs">
        <Text>
          When you submit, the server fetches the download URL itself, streams
          the bytes through a SHA-256 hasher, and stores the resulting hash
          plus the byte count on the entry as{' '}
          <Code>download_hash.sha256</Code> and <Code>download_size</Code>.
        </Text>
        <Text>
          When a launcher later installs the mod, it fetches the same URL and
          recomputes the hash locally. If the bytes have changed (file
          replaced, host swapped content, mid-flight tampering), the hashes
          won&rsquo;t match and the install is aborted.
        </Text>
        <Text size="sm" c="dimmed">
          This is the main reason auto-updates are safe: a malicious actor
          can&rsquo;t silently swap a mod&rsquo;s payload without invalidating
          every launcher&rsquo;s hash check at the same time.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'fields-required',
    question: 'What do the required fields on the submit form mean?',
    answer: (
      <Table withTableBorder withColumnBorders verticalSpacing="xs" fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Field</Table.Th>
            <Table.Th>What it is</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td><Code>identifier</Code></Table.Td>
            <Table.Td>
              Globally unique slug for your mod (2–128 chars, letters, digits,
              {' '}<Code>-</Code> and <Code>_</Code>). Cannot be changed once
              claimed. Acts like a package name.
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td><Code>name</Code></Table.Td>
            <Table.Td>Human-readable display name (1–256 chars).</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td><Code>abstract</Code></Table.Td>
            <Table.Td>One-line summary, max 512 chars. Shown in card grids.</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td><Code>author</Code></Table.Td>
            <Table.Td>One author or a list of authors.</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td><Code>version</Code></Table.Td>
            <Table.Td>Semver-ish string (e.g. <Code>1.0.3</Code>). Determines update detection.</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td><Code>license</Code></Table.Td>
            <Table.Td>SPDX identifier (e.g. <Code>MIT</Code>, <Code>CC-BY-4.0</Code>) or <Code>restricted</Code>.</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td><Code>download</Code></Table.Td>
            <Table.Td>HTTPS URL(s) to the archive. Required for normal mods.</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    ),
  },
  {
    value: 'fields-optional',
    question: 'What about the optional fields — kind, mod_type, multiplayer scope?',
    answer: (
      <Stack gap="sm">
        <div>
          <Text fw={600}><Code>kind</Code></Text>
          <List size="sm" withPadding spacing={2}>
            <List.Item><Code>package</Code> — a normal mod with files (default).</List.Item>
            <List.Item><Code>metapackage</Code> — a collection that has no files of its own; just a list of dependencies.</List.Item>
            <List.Item><Code>dlc</Code> — official or bundled content (rare).</List.Item>
          </List>
        </div>
        <div>
          <Text fw={600}><Code>mod_type</Code></Text>
          <Text size="sm">
            One of: <Code>vehicle</Code>, <Code>map</Code>, <Code>skin</Code>,{' '}
            <Code>ui_app</Code>, <Code>sound</Code>, <Code>license_plate</Code>,{' '}
            <Code>scenario</Code>, <Code>automation</Code>, <Code>other</Code>.
            Drives filtering and category icons in launchers.
          </Text>
        </div>
        <div>
          <Text fw={600}><Code>multiplayer_scope</Code></Text>
          <List size="sm" withPadding spacing={2}>
            <List.Item><Code>client</Code> — installs into the player&rsquo;s game (default).</List.Item>
            <List.Item><Code>server</Code> — a BeamMP server-side plugin only.</List.Item>
            <List.Item><Code>both</Code> — has both components. Either ship one archive with <Code>Resources/Client</Code> and <Code>Resources/Server</Code> folders, or specify separate <Code>server_download</Code> + <Code>server_download_hash</Code> fields.</List.Item>
          </List>
        </div>
        <div>
          <Text fw={600}><Code>release_status</Code></Text>
          <Text size="sm">
            <Code>stable</Code> (default), <Code>testing</Code>, or{' '}
            <Code>development</Code>. Lets users opt in/out of unstable
            versions.
          </Text>
        </div>
        <div>
          <Text fw={600}>BeamNG / BeamMP version constraints</Text>
          <Text size="sm">
            <Code>beamng_version</Code>, <Code>beamng_version_min</Code>,{' '}
            <Code>beamng_version_max</Code>, and{' '}
            <Code>beammp_version_min</Code> let launchers warn or block
            install on incompatible game versions.
          </Text>
        </div>
      </Stack>
    ),
  },
  {
    value: 'dependencies',
    question: 'How do dependencies work?',
    answer: (
      <Stack gap="xs">
        <Text>An entry can declare relationships to other mods:</Text>
        <List size="sm" withPadding spacing={2}>
          <List.Item><Code>depends</Code> — required; the launcher will install these too.</List.Item>
          <List.Item><Code>recommends</Code> — installed by default but the user can opt out.</List.Item>
          <List.Item><Code>suggests</Code> — not installed by default; offered as opt-in.</List.Item>
          <List.Item><Code>supports</Code> — informational; this mod enhances those mods if present.</List.Item>
          <List.Item><Code>conflicts</Code> — must not be installed together.</List.Item>
          <List.Item><Code>provides</Code> — virtual identifiers this mod satisfies (lets one mod stand in for another).</List.Item>
          <List.Item><Code>replaced_by</Code> — pointer to a successor mod when this one is deprecated.</List.Item>
        </List>
        <Text size="sm" c="dimmed">
          Each entry can pin a version range (<Code>min_version</Code>,{' '}
          <Code>max_version</Code>), and dependency rows can offer a choice
          between several alternatives via <Code>any_of</Code>.
        </Text>
      </Stack>
    ),
  },
  {
    value: 'remove',
    question: 'How do I get my mod removed?',
    answer: (
      <Text>
        If you&rsquo;re the registered owner, open your{' '}
        <strong>Dashboard → Mods you own</strong>, click the ⋮ menu on the
        mod card, and choose <strong>Request deletion…</strong>. You provide
        a short reason; an admin reviews every request before the entry is
        removed via PR. You can cancel a pending request from the same menu
        at any time before the admin decides. If you&rsquo;re the original
        author but the entry is unclaimed (or claimed by someone else), file
        a claim first; if that&rsquo;s contested, contact an admin with proof
        of authorship (e.g. a commit / post on the upstream source) and
        they&rsquo;ll remove or transfer the entry.
      </Text>
    ),
  },
  {
    value: 'cost',
    question: 'Does it cost anything?',
    answer: (
      <Text>
        No. The registry is free to use, free to submit to, and free to
        integrate with. It&rsquo;s a community project, and because the
        compressed index is just a static file on GitHub Releases, there are
        effectively no hosting costs for distribution.
      </Text>
    ),
  },
  {
    value: 'where-files-live',
    question: 'Where do mod files actually live?',
    answer: (
      <Text>
        On whatever host the author chose — typically the BeamNG.com
        repository, GitHub releases, or another file host on the allowlist.
        This site never stores the binaries themselves. The only data on this
        server is metadata, accounts, submissions, audit logs, and cached
        thumbnails.
      </Text>
    ),
  },
  {
    value: 'beammp-server-guide',
    question: 'Guide: Create a BeamMP server in BeamNG Content Manager',
    answer: <BeamMpServerGuideAnswer />,
  },
  {
    value: 'careermp-server-guide',
    question: 'Guide: Set up a base CareerMP server in BeamNG Content Manager',
    answer: <CareerMpServerGuideAnswer />,
  },
]

export function FaqPage() {
  const location = useLocation()
  const [openItems, setOpenItems] = useState<string[]>(['what-is', 'benefit'])

  useEffect(() => {
    const hashToAccordionValue: Record<string, string> = {
      '#beammp-server-guide': 'beammp-server-guide',
      '#careermp-server-guide': 'careermp-server-guide',
    }

    const targetValue = hashToAccordionValue[location.hash]
    if (!targetValue) return

    setOpenItems((current) => (current.includes(targetValue) ? current : [...current, targetValue]))

    const scrollToTarget = () => {
      const target = document.getElementById(targetValue)
      if (!target) return
      const top = Math.max(0, window.scrollY + target.getBoundingClientRect().top - 24)
      window.scrollTo({ top, left: 0, behavior: 'smooth' })
    }

    // First pass: immediate jump for responsiveness.
    requestAnimationFrame(scrollToTarget)

    // Second pass: after accordion expansion/layout settles.
    const timeoutId = window.setTimeout(scrollToTarget, 220)
    return () => window.clearTimeout(timeoutId)
  }, [location.hash])

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'How do I create a BeamMP server with BMR?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Install BeamNG Content Manager, open its self-hosted Server Manager, create or select a BeamMP server instance, ensure the BeamMP-Server executable is available, use the integrated Tailscale flow when you need friend hosting without manual port forwarding, then configure and launch the server from CM.',
        },
      },
      {
        '@type': 'Question',
        name: 'Can I use BeamNG Content Manager with this registry?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Yes. BMR is a mod source for BeamNG Content Manager. Approved mods are discoverable and installable directly in the app.',
        },
      },
      {
        '@type': 'Question',
        name: 'How do I prepare a CareerMP server mod set?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Start from a working BeamMP server, install the base CareerMP release into the server root, set MaxCars to 100 or more and the map to West Coast, run the server once to generate CareerMP config.json, then return to Content Manager to edit the generated CareerMP configuration and any optional plugin settings.',
        },
      },
    ],
  }

  return (
    <Container size="md" py="md">
      <Stack gap="md">
        <Seo
          title="Create BeamMP Server and CareerMP Setup FAQ | BeamNG Mod Registry"
          description="BeamNG Mod Registry FAQ covering BeamNG Content Manager integration, creating a BeamMP server setup, and preparing CareerMP-compatible mod packs."
          canonicalPath="/faq"
          jsonLd={faqSchema}
        />
        <Stack gap={4}>
          <Title order={2}>Frequently asked questions</Title>
          <Text c="dimmed">
            New here? Start with{' '}
            <Anchor component={Link} to="/registry">browse the registry</Anchor>
            {' '}or{' '}
            <Anchor component={Link} to="/submit/manual">submit a mod</Anchor>.
          </Text>
          <Text c="dimmed" size="sm">
            Popular guides:{' '}
            <Anchor component={Link} to="/content-manager">BeamNG Content Manager</Anchor>
            {' '}download and setup,{' '}
            <Anchor component={Link} to="/faq#beammp-server-guide">create BeamMP server workflow</Anchor>
            , and{' '}
            <Anchor component={Link} to="/faq#careermp-server-guide">set up a CareerMP server</Anchor>.
          </Text>
        </Stack>
        <Accordion variant="separated" multiple value={openItems} onChange={setOpenItems}>
          {ITEMS.map((item) => (
            <Accordion.Item key={item.value} value={item.value}>
              <Accordion.Control>{item.question}</Accordion.Control>
              <Accordion.Panel>{item.answer}</Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
        <Stack gap="xs" align="center" mt="md">
          <Text size="sm" c="dimmed" ta="center">
            Still have a question? Join the{' '}
            <Anchor href={DISCORD_INVITE_URL} target="_blank" rel="noreferrer">
              Discord
            </Anchor>
            {' '}or open an issue on the{' '}
            <Anchor href="https://github.com/musanajam11/BeamNG-Mod-Registry" target="_blank" rel="noreferrer">
              project repository
            </Anchor>
            .
          </Text>
          <DiscordLink label="Join the Discord" />
        </Stack>
      </Stack>
    </Container>
  )
}
