/**
 * Registry Browser — searchable, paginated grid of all mods currently
 * published in the registry. Authors use this to discover identifiers when
 * filling in `depends`, `recommends`, `suggests`, `provides`, etc.
 *
 * Selecting a card opens a drawer with full details and a copy-to-clipboard
 * button on the identifier.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ActionIcon, Alert, Anchor, Badge, Button, Card, CloseButton, Container, CopyButton,
  Drawer, Grid, Group, Image, Pagination, Paper, ScrollArea, Select, Stack,
  Text, TextInput, Title, Tooltip,
} from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { api } from '../api/client'
import { useSubmitDraft } from '../state/SubmitDraftContext'

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
}

const PAGE_SIZE = 24

function isHttpUrl(s: string | undefined): s is string {
  return !!s && /^https?:\/\//i.test(s)
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
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)

  // Reset to page 1 when filters change.
  const queryKey = ['mods', { q: debouncedQ, type, page }]
  const list = useQuery({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams()
      if (debouncedQ) params.set('q', debouncedQ)
      if (type) params.set('type', type)
      params.set('page', String(page))
      params.set('pageSize', String(PAGE_SIZE))
      return api.get<ModListResponse>(`/mods?${params.toString()}`)
    },
    placeholderData: (prev) => prev,
  })

  const detail = useQuery<ModDetailResponse>({
    queryKey: ['mod', selected],
    queryFn: () => api.get<ModDetailResponse>(`/mods/${encodeURIComponent(selected!)}`),
    enabled: !!selected,
  })

  const typeOptions = useMemo(() => {
    const facets = list.data?.facets.mod_types ?? {}
    return Object.entries(facets)
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: `${value} (${count})` }))
  }, [list.data])

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1

  return (
    <Container size={1200}>
      <Group justify="space-between" align="flex-end" mb="md">
        <Title order={2}>Registry browser</Title>
        {list.data && (
          <Text c="dimmed" size="sm">
            {list.data.total.toLocaleString()} mod{list.data.total === 1 ? '' : 's'} indexed
          </Text>
        )}
      </Group>

      <Paper withBorder p="md" radius="md" mb="md">
        <Group wrap="wrap" gap="sm">
          <TextInput
            placeholder="Search by name, identifier, author, tag…"
            value={q}
            onChange={(e) => { setQ(e.currentTarget.value); setPage(1) }}
            style={{ flex: 1, minWidth: 240 }}
            rightSection={
              q ? <CloseButton onClick={() => { setQ(''); setPage(1) }} /> : null
            }
          />
          <Select
            placeholder="All types"
            value={type}
            onChange={(v) => { setType(v); setPage(1) }}
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

      {list.data && list.data.items.length === 0 && !list.isFetching && (
        <Alert color="yellow">No mods match your filters.</Alert>
      )}

      <Grid>
        {list.data?.items.map((m) => (
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

      {list.data && totalPages > 1 && (
        <Group justify="center" mt="lg">
          <Pagination value={page} onChange={setPage} total={totalPages} />
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
            onClose={() => setSelected(null)}
          />
        )}
      </Drawer>
    </Container>
  )
}

function ModDetailView({ mod, watch, onClose }: { mod: ModDetail; watch?: { kref?: string; filter_asset?: string }; onClose: () => void }) {
  const draft = useSubmitDraft()
  const navigate = useNavigate()

  const proposeEdit = (bumpVersion: boolean) => {
    draft.loadFromExisting(mod.raw, { bumpVersion, watch })
    onClose()
    navigate('/submit/manual')
  }

  const resources = mod.resources ?? {}
  return (
    <Stack>
      {isHttpUrl(mod.thumbnail) && (
        <Image src={mod.thumbnail} alt={mod.name} radius="md" />
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
          <Text size="sm" fw={600}>Are you the author of this mod?</Text>
          <Text size="xs" c="dimmed">
            Propose changes (e.g. add a thumbnail, fix metadata, publish a new version).
            Edits to existing entries always go through admin review so we can verify
            authorship before publishing.
          </Text>
          <Group gap="xs">
            <Button size="xs" variant="light" onClick={() => proposeEdit(false)}>
              Propose edit
            </Button>
            <Button size="xs" onClick={() => proposeEdit(true)}>
              Submit new version
            </Button>
          </Group>
        </Stack>
      </Paper>

      <details>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: '#94a3b8' }}>
          Raw .beammod
        </summary>
        <pre
          style={{
            background: '#0b1220', color: '#cbd5e1', padding: 12, borderRadius: 6,
            fontSize: 11, overflow: 'auto', maxHeight: 360, marginTop: 8,
          }}
        >
          {JSON.stringify(mod.raw, null, 2)}
        </pre>
      </details>
    </Stack>
  )
}
