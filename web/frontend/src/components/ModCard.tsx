/**
 * Shared mod-tile components used by the Registry Browser grid and the
 * Dashboard's "Mods you own" section. Extracted so both surfaces render
 * the same card visual without duplicating layout logic.
 */
import { Avatar, Badge, Card, Group, Image, Stack, Text, Tooltip } from '@mantine/core'
import type { OwnerInfo } from '../api/client'

export interface LastEdit {
  identifier: string
  user_id: number
  display_name: string
  avatar_url: string | null
  kind: string
  version: string | null
  decided_at: number | null
}

export interface RatingInfo {
  avg: number
  count: number
  mine: number | null
}

export interface ModCardData {
  identifier: string
  name: string
  abstract?: string
  author?: string
  kind: string
  mod_type?: string
  version: string
  thumbnail?: string
  verified: boolean
  last_edit: LastEdit | null
  rating: RatingInfo
  owner: OwnerInfo | null
}

export function isHttpUrl(s: string | undefined): s is string {
  return !!s && /^https?:\/\//i.test(s)
}

export function initialsOf(name: string): string {
  return name.slice(0, 2).toUpperCase()
}

export function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const sec = Math.round(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}\u00a0min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}\u00a0hr ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}\u00a0day${day === 1 ? '' : 's'} ago`
  return new Date(ts).toLocaleDateString()
}

export const KIND_LABEL: Record<string, string> = {
  manual_beammod: 'Manual edit',
  netbeammod_github: 'GitHub watcher',
  netbeammod_beamng: 'BeamNG watcher',
  claim: 'Claimed',
  new_version: 'New version',
}

export function ClaimedByBadge({ owner, compact }: { owner: OwnerInfo; compact?: boolean }) {
  return (
    <Tooltip label={`Claimed by ${owner.display_name}`} withArrow openDelay={300}>
      <Group gap={6} wrap="nowrap" align="center" style={{ minWidth: 0 }}>
        <Avatar src={owner.avatar_url ?? undefined} size={compact ? 18 : 22} radius="xl">
          {initialsOf(owner.display_name)}
        </Avatar>
        <Text size="xs" c="teal.4" lineClamp={1} style={{ minWidth: 0 }}>
          claimed by {owner.display_name}
        </Text>
      </Group>
    </Tooltip>
  )
}

export function LastEditedBadge({ edit, compact }: { edit: LastEdit; compact?: boolean }) {
  const when = formatRelativeTime(edit.decided_at)
  const label = `${KIND_LABEL[edit.kind] ?? 'Edited'} by ${edit.display_name}${when ? ` — ${when}` : ''}`
  return (
    <Tooltip label={label} withArrow openDelay={300}>
      <Group gap={6} wrap="nowrap" align="center" style={{ minWidth: 0 }}>
        <Avatar src={edit.avatar_url ?? undefined} size={compact ? 18 : 22} radius="xl">
          {initialsOf(edit.display_name)}
        </Avatar>
        <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
          edited by {edit.display_name}
          {when ? ` · ${when}` : ''}
        </Text>
      </Group>
    </Tooltip>
  )
}

export function RatingBadge({ rating }: { rating: RatingInfo }) {
  if (rating.count === 0) {
    return (
      <Tooltip label="No ratings yet — be the first to rate this mod" withArrow openDelay={300}>
        <Text size="xs" c="dimmed">
          ☆ unrated
        </Text>
      </Tooltip>
    )
  }
  const label = `Average ${rating.avg.toFixed(1)} from ${rating.count} rating${rating.count === 1 ? '' : 's'}${rating.mine ? ` · you rated ${rating.mine}` : ''}`
  return (
    <Tooltip label={label} withArrow openDelay={300}>
      <Group gap={4} wrap="nowrap" align="center" style={{ minWidth: 0 }}>
        <Text size="xs" c="yellow.5" lh={1}>★</Text>
        <Text size="xs" fw={600} lh={1}>{rating.avg.toFixed(1)}</Text>
        <Text size="xs" c="dimmed" lh={1}>({rating.count})</Text>
        {rating.mine ? (
          <Text size="xs" c="blue.4" lh={1} ml={2}>· you: {rating.mine}</Text>
        ) : null}
      </Group>
    </Tooltip>
  )
}

export function ThumbBox({ src, alt }: { src?: string; alt: string }) {
  if (isHttpUrl(src)) {
    return (
      <Image
        className="registry-thumb"
        src={src}
        alt={alt}
        h={140}
        fit="cover"
        fallbackSrc="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 70'><rect width='100' height='70' fill='%23222'/><text x='50' y='40' text-anchor='middle' fill='%23666' font-size='10' font-family='sans-serif'>no preview</text></svg>"
      />
    )
  }
  return (
    <div
      className="registry-thumb"
      style={{
        height: 140,
        background: 'linear-gradient(135deg,#1f2937,#0f172a)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#475569', fontSize: 12, fontFamily: 'monospace',
      }}
    >
      no preview
    </div>
  )
}

interface ModCardProps {
  mod: ModCardData
  onClick: () => void
  /**
   * Number of pending submissions that the viewer (assumed owner) needs to
   * review for this mod. When > 0, an orange "n to review" badge is shown
   * on top of the thumbnail.
   */
  pendingCount?: number
  /**
   * Optional overlay rendered in the top-right of the thumbnail (e.g. a
   * Menu trigger). Click events inside this slot are stopped from
   * propagating to the card's onClick.
   */
  actions?: React.ReactNode
  /**
   * Optional content rendered at the bottom of the card body (after the
   * tag/version row). Used by the dashboard to surface per-card status
   * like "deletion pending admin review".
   */
  footer?: React.ReactNode
}

export function ModCard({ mod, onClick, pendingCount = 0, actions, footer }: ModCardProps) {
  return (
    <Card
      withBorder
      padding={0}
      radius="md"
      className="registry-card"
      style={{ cursor: 'pointer', overflow: 'hidden', height: '100%' }}
      onClick={onClick}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const x = ((e.clientX - r.left) / r.width) * 100
        const y = ((e.clientY - r.top) / r.height) * 100
        e.currentTarget.style.setProperty('--mx', `${x}%`)
        e.currentTarget.style.setProperty('--my', `${y}%`)
      }}
    >
      <Card.Section className="registry-thumb-wrap" style={{ position: 'relative', overflow: 'hidden' }}>
        <ThumbBox src={mod.thumbnail} alt={mod.name} />
        {mod.verified && (
          <Tooltip label="Verified — author-curated entry" withArrow>
            <Badge
              color="blue"
              variant="filled"
              size="sm"
              leftSection={<span style={{ fontSize: 11, lineHeight: 1 }}>✓</span>}
              style={{ position: 'absolute', top: 8, right: 8 }}
            >
              Verified
            </Badge>
          </Tooltip>
        )}
        {pendingCount > 0 && (
          <Tooltip
            label={`${pendingCount} pending change${pendingCount === 1 ? '' : 's'} awaiting your review`}
            withArrow
          >
            <Badge
              color="orange"
              variant="filled"
              size="sm"
              style={{ position: 'absolute', top: 8, left: 8 }}
            >
              {pendingCount} to review
            </Badge>
          </Tooltip>
        )}
        {actions && (
          <div
            style={{ position: 'absolute', bottom: 8, right: 8 }}
            onClick={(e) => e.stopPropagation()}
          >
            {actions}
          </div>
        )}
      </Card.Section>
      <Stack p="sm" gap={6}>
        <Group gap={4} wrap="nowrap" align="center">
          <Text fw={600} lineClamp={1} style={{ flex: 1 }}>{mod.name}</Text>
        </Group>
        <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>
          {mod.identifier}
        </Text>
        {mod.author && (
          <Text size="xs" c="dimmed" lineClamp={1}>by {mod.author}</Text>
        )}
        {mod.owner && <ClaimedByBadge owner={mod.owner} compact />}
        {mod.last_edit && <LastEditedBadge edit={mod.last_edit} compact />}
        <RatingBadge rating={mod.rating} />
        {mod.abstract && (
          <Text size="xs" lineClamp={2}>{mod.abstract}</Text>
        )}
        <Group gap={4} mt={4}>
          {mod.mod_type && <Badge size="xs" variant="light">{mod.mod_type}</Badge>}
          {mod.kind && mod.kind !== 'package' && (
            <Badge size="xs" variant="light" color="grape">{mod.kind}</Badge>
          )}
          <Badge size="xs" variant="outline">v{mod.version}</Badge>
        </Group>
        {footer}
      </Stack>
    </Card>
  )
}
