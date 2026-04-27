/**
 * Registry Browser — searchable, paginated grid of all mods currently
 * published in the registry. Authors use this to discover identifiers when
 * filling in `depends`, `recommends`, `suggests`, `provides`, etc.
 *
 * Selecting a card opens a drawer with full details and a copy-to-clipboard
 * button on the identifier.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  ActionIcon, Alert, Anchor, Avatar, Badge, Button, Card, CloseButton, Collapse,
  Container, CopyButton, Divider, Drawer, Grid, Group, Image, Loader, Paper,
  ScrollArea, Select, Stack, Text, TextInput, Title, Tooltip, UnstyledButton,
} from '@mantine/core'
import { useDebouncedValue, useDisclosure } from '@mantine/hooks'
import { api } from '../api/client'
import { useSubmitDraft } from '../state/SubmitDraftContext'

interface LastEdit {
  identifier: string
  user_id: number
  display_name: string
  avatar_url: string | null
  kind: string
  version: string | null
  decided_at: number | null
}

interface ModListItem {
  identifier: string
  name: string
  abstract?: string
  author?: string
  license?: string
  kind: string
  mod_type?: string
  version: string
  download?: string
  thumbnail?: string
  tags: string[]
  release_status?: string
  multiplayer_scope?: string
  verified: boolean
  resources?: Record<string, unknown>
  versions: string[]
  last_edit: LastEdit | null
}

interface ModListResponse {
  items: ModListItem[]
  total: number
  page: number
  pageSize: number
  facets: { mod_types: Record<string, number> }
}

interface ModDetail extends ModListItem {
  raw: Record<string, unknown>
}

interface ModDetailResponse {
  mod: ModDetail
  watch?: { kref?: string; filter_asset?: string }
  last_edit: LastEdit | null
}

const PAGE_SIZE = 24

function isHttpUrl(s: string | undefined): s is string {
  return !!s && /^https?:\/\//i.test(s)
}

function initialsOf(name: string): string {
  return name.slice(0, 2).toUpperCase()
}

function formatRelativeTime(ts: number | null | undefined): string {
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

const KIND_LABEL: Record<string, string> = {
  manual_beammod: 'Manual edit',
  netbeammod_github: 'GitHub watcher',
  netbeammod_beamng: 'BeamNG watcher',
  claim: 'Claimed',
  new_version: 'New version',
}

function LastEditedBadge({ edit, compact }: { edit: LastEdit; compact?: boolean }) {
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

function ThumbBox({ src, alt }: { src?: string; alt: string }) {
  if (isHttpUrl(src)) {
    return (
      <Image
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

export function RegistryBrowserPage() {
  const [q, setQ] = useState('')
  const [debouncedQ] = useDebouncedValue(q, 250)
  const [type, setType] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // Infinite scroll: each page returns PAGE_SIZE items; we fetch the next
  // page when the sentinel scrolls into view. Filter changes reset the
  // scroll automatically because the query key changes.
  const list = useInfiniteQuery({
    queryKey: ['mods', { q: debouncedQ, type }],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      if (debouncedQ) params.set('q', debouncedQ)
      if (type) params.set('type', type)
      params.set('page', String(pageParam))
      params.set('pageSize', String(PAGE_SIZE))
      return api.get<ModListResponse>(`/mods?${params.toString()}`)
    },
    getNextPageParam: (last) => {
      const loaded = last.page * last.pageSize
      return loaded < last.total ? last.page + 1 : undefined
    },
  })

  // Flatten pages → single array for rendering. Memoised so the grid only
  // re-renders when actual data changes.
  const items = useMemo(
    () => list.data?.pages.flatMap((p) => p.items) ?? [],
    [list.data],
  )
  const total = list.data?.pages[0]?.total ?? 0
  const facets = list.data?.pages[0]?.facets ?? { mod_types: {} }

  // IntersectionObserver-based auto-load. Sentinel div sits below the grid.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !list.hasNextPage) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !list.isFetchingNextPage) {
          void list.fetchNextPage()
        }
      },
      { rootMargin: '400px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [list.hasNextPage, list.isFetchingNextPage, list.fetchNextPage, items.length])

  const detail = useQuery<ModDetailResponse>({
    queryKey: ['mod', selected],
    queryFn: () => api.get<ModDetailResponse>(`/mods/${encodeURIComponent(selected!)}`),
    enabled: !!selected,
  })

  const typeOptions = useMemo(() => {
    return Object.entries(facets.mod_types ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: `${value} (${count})` }))
  }, [facets])

  return (
    <Container size={1200}>
      <Group justify="space-between" align="flex-end" mb="md">
        <Title order={2}>Registry browser</Title>
        {list.data && (
          <Text c="dimmed" size="sm">
            {total.toLocaleString()} mod{total === 1 ? '' : 's'} indexed
          </Text>
        )}
      </Group>

      <Paper withBorder p="md" radius="md" mb="md">
        <Group wrap="wrap" gap="sm">
          <TextInput
            placeholder="Search by name, identifier, author, tag…"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 240 }}
            rightSection={
              q ? <CloseButton onClick={() => setQ('')} /> : null
            }
          />
          <Select
            placeholder="All types"
            value={type}
            onChange={(v) => setType(v)}
            data={typeOptions}
            clearable
            searchable
            w={220}
          />
        </Group>
      </Paper>

      {list.isError && (
        <Alert color="red" mb="md">Failed to load registry.</Alert>
      )}

      {list.data && items.length === 0 && !list.isFetching && (
        <Alert color="yellow">No mods match your filters.</Alert>
      )}

      <Grid>
        {items.map((m) => (
          <Grid.Col key={m.identifier} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
            <Card
              withBorder
              padding={0}
              radius="md"
              style={{ cursor: 'pointer', overflow: 'hidden', height: '100%' }}
              onClick={() => setSelected(m.identifier)}
            >
              <Card.Section style={{ position: 'relative' }}>
                <ThumbBox src={m.thumbnail} alt={m.name} />
                {m.verified && (
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
              </Card.Section>
              <Stack p="sm" gap={6}>
                <Group gap={4} wrap="nowrap" align="center">
                  <Text fw={600} lineClamp={1} style={{ flex: 1 }}>{m.name}</Text>
                </Group>
                <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>
                  {m.identifier}
                </Text>
                {m.author && (
                  <Text size="xs" c="dimmed" lineClamp={1}>by {m.author}</Text>
                )}
                {m.last_edit && <LastEditedBadge edit={m.last_edit} compact />}
                {m.abstract && (
                  <Text size="xs" lineClamp={2}>{m.abstract}</Text>
                )}
                <Group gap={4} mt={4}>
                  {m.mod_type && <Badge size="xs" variant="light">{m.mod_type}</Badge>}
                  {m.kind && m.kind !== 'package' && (
                    <Badge size="xs" variant="light" color="grape">{m.kind}</Badge>
                  )}
                  <Badge size="xs" variant="outline">v{m.version}</Badge>
                </Group>
              </Stack>
            </Card>
          </Grid.Col>
        ))}
      </Grid>

      {/* Sentinel observed by IntersectionObserver to auto-load the next
          page. Also acts as a manual fallback button so users on browsers
          without IO support can still load more. */}
      {items.length > 0 && (
        <Group justify="center" mt="lg" ref={sentinelRef as React.Ref<HTMLDivElement>}>
          {list.isFetchingNextPage ? (
            <Loader size="sm" />
          ) : list.hasNextPage ? (
            <Button variant="subtle" onClick={() => list.fetchNextPage()}>
              Load more
            </Button>
          ) : (
            <Text c="dimmed" size="sm">End of results</Text>
          )}
        </Group>
      )}

      <Drawer
        opened={!!selected}
        onClose={() => setSelected(null)}
        position="right"
        size="lg"
        title={detail.data?.mod.name ?? selected ?? 'Mod'}
        scrollAreaComponent={ScrollArea.Autosize}
      >
        {selected && detail.isLoading && <Text c="dimmed">Loading…</Text>}
        {detail.data && (
          <ModDetailView
            mod={detail.data.mod}
            watch={detail.data.watch}
            lastEdit={detail.data.last_edit}
            onClose={() => setSelected(null)}
          />
        )}
      </Drawer>
    </Container>
  )
}

function ModDetailView({ mod, watch, lastEdit, onClose }: { mod: ModDetail; watch?: { kref?: string; filter_asset?: string }; lastEdit: LastEdit | null; onClose: () => void }) {
  const draft = useSubmitDraft()
  const navigate = useNavigate()
  const [historyOpen, historyToggle] = useDisclosure(false)

  // History is fetched lazily the first time the user expands the dropdown
  // so we don't pay for it on every drawer open.
  const history = useQuery<{ history: LastEdit[] }>({
    queryKey: ['mod-history', mod.identifier],
    queryFn: () => api.get<{ history: LastEdit[] }>(`/mods/${encodeURIComponent(mod.identifier)}/history`),
    enabled: historyOpen,
  })

  const proposeEdit = (bumpVersion: boolean) => {
    draft.loadFromExisting(mod.raw, { bumpVersion, watch })
    onClose()
    navigate('/submit/manual')
  }

  const resources = mod.resources ?? {}
  return (
    <Stack style={{ minWidth: 0 }}>
      {isHttpUrl(mod.thumbnail) && (
        <Image
          src={mod.thumbnail}
          alt={mod.name}
          radius="md"
          h={220}
          fit="contain"
        />
      )}

      <Group gap={6}>
        <Text size="sm" c="dimmed">Identifier:</Text>
        <Text size="sm" ff="monospace">{mod.identifier}</Text>
        <CopyButton value={mod.identifier} timeout={1500}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? 'Copied' : 'Copy identifier'}>
              <ActionIcon
                size="sm"
                variant={copied ? 'filled' : 'light'}
                color={copied ? 'teal' : 'gray'}
                onClick={copy}
                aria-label="Copy identifier"
              >
                {copied ? '✓' : '⧉'}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>

      <Group gap={6} wrap="wrap">
        {mod.verified && (
          <Badge color="blue" variant="filled" leftSection={<span style={{ fontSize: 11 }}>✓</span>}>
            Verified
          </Badge>
        )}
        <Badge variant="light">v{mod.version}</Badge>
        {mod.kind && mod.kind !== 'package' && <Badge variant="light" color="grape">{mod.kind}</Badge>}
        {mod.mod_type && <Badge variant="light" color="blue">{mod.mod_type}</Badge>}
        {mod.release_status && <Badge variant="outline">{mod.release_status}</Badge>}
        {mod.multiplayer_scope && <Badge variant="outline" color="cyan">mp: {mod.multiplayer_scope}</Badge>}
        {mod.license && <Badge variant="outline" color="gray">{mod.license}</Badge>}
      </Group>

      {mod.author && <Text size="sm"><strong>Author:</strong> {mod.author}</Text>}
      {mod.abstract && <Text size="sm">{mod.abstract}</Text>}

      {lastEdit && (
        <Paper withBorder p="sm" radius="sm">
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                <Avatar src={lastEdit.avatar_url ?? undefined} size={32} radius="xl">
                  {initialsOf(lastEdit.display_name)}
                </Avatar>
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600} lineClamp={1}>
                    Last edited by {lastEdit.display_name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {KIND_LABEL[lastEdit.kind] ?? 'Edit'}
                    {lastEdit.version ? ` · v${lastEdit.version}` : ''}
                    {lastEdit.decided_at ? ` · ${formatRelativeTime(lastEdit.decided_at)}` : ''}
                  </Text>
                </Stack>
              </Group>
              <UnstyledButton onClick={historyToggle.toggle}>
                <Text size="xs" c="blue">
                  {historyOpen ? 'Hide history' : 'Show history'}
                </Text>
              </UnstyledButton>
            </Group>
            <Collapse in={historyOpen}>
              <Divider mb="xs" />
              {history.isLoading && <Text size="xs" c="dimmed">Loading history…</Text>}
              {history.isError && <Text size="xs" c="red">Failed to load history.</Text>}
              {history.data && history.data.history.length === 0 && (
                <Text size="xs" c="dimmed">No prior edits recorded.</Text>
              )}
              {history.data && history.data.history.length > 0 && (
                <Stack gap={6}>
                  {history.data.history.map((h, idx) => (
                    <Group key={`${h.user_id}-${h.decided_at}-${idx}`} gap="sm" wrap="nowrap" align="center">
                      <Avatar src={h.avatar_url ?? undefined} size={24} radius="xl">
                        {initialsOf(h.display_name)}
                      </Avatar>
                      <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                        <Text size="xs" lineClamp={1}>
                          <strong>{h.display_name}</strong> · {KIND_LABEL[h.kind] ?? h.kind}
                          {h.version ? ` · v${h.version}` : ''}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {h.decided_at ? new Date(h.decided_at).toLocaleString() : '—'}
                        </Text>
                      </Stack>
                    </Group>
                  ))}
                </Stack>
              )}
            </Collapse>
          </Stack>
        </Paper>
      )}

      {mod.tags.length > 0 && (
        <Group gap={4}>
          {mod.tags.map((t) => <Badge key={t} size="xs" variant="dot">{t}</Badge>)}
        </Group>
      )}

      {mod.versions.length > 1 && (
        <Text size="xs" c="dimmed">
          Versions on file: {mod.versions.join(', ')}
        </Text>
      )}

      <Stack gap={4}>
        {isHttpUrl(mod.download) && (
          <Text size="xs">
            <strong>Download:</strong>{' '}
            <Anchor href={mod.download} target="_blank" rel="noopener noreferrer">
              {mod.download}
            </Anchor>
          </Text>
        )}
        {Object.entries(resources).map(([k, v]) =>
          typeof v === 'string' && isHttpUrl(v) ? (
            <Text key={k} size="xs">
              <strong>{k}:</strong>{' '}
              <Anchor href={v} target="_blank" rel="noopener noreferrer">{v}</Anchor>
            </Text>
          ) : null
        )}
      </Stack>

      {typeof mod.raw.description === 'string' && (mod.raw.description as string).length > 0 && (
        <Paper withBorder p="sm" radius="sm">
          <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>
            {String(mod.raw.description)}
          </Text>
        </Paper>
      )}

      <Paper withBorder p="sm" radius="sm" bg="dark.7">
        <Stack gap="xs">
          <Text size="sm" fw={600}>Spotted something to improve?</Text>
          <Text size="xs" c="dimmed">
            Anyone who's used this mod can suggest fixes — corrected metadata, a better
            thumbnail, missing tags, broken download links, etc. Edits go through admin
            review before publishing.
          </Text>
          <Group gap="xs">
            <Button size="xs" variant="light" onClick={() => proposeEdit(false)}>
              Propose edit
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Paper withBorder p="sm" radius="sm" bg="dark.7">
        <Stack gap="xs">
          <Text size="sm" fw={600}>Are you the author of this mod?</Text>
          <Text size="xs" c="dimmed">
            Publish a new version (bumps the version number and creates a fresh release
            entry). Admin review verifies authorship before publishing.
          </Text>
          <Group gap="xs">
            <Button size="xs" onClick={() => proposeEdit(true)}>
              Submit new version
            </Button>
          </Group>
        </Stack>
      </Paper>

      <details style={{ minWidth: 0, width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: '#94a3b8' }}>
          Raw .beammod
        </summary>
        <pre
          style={{
            background: '#0b1220', color: '#cbd5e1', padding: 12, borderRadius: 6,
            fontSize: 11, overflow: 'auto', maxHeight: 360, marginTop: 8,
            width: '100%', maxWidth: '100%', boxSizing: 'border-box',
            // pre-wrap + word-break keeps long URLs/strings from forcing the
            // drawer to grow horizontally.
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {JSON.stringify(mod.raw, null, 2)}
        </pre>
      </details>
    </Stack>
  )
}
