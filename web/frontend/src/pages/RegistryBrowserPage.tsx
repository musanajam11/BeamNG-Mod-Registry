/**
 * Registry Browser — searchable, paginated grid of all mods currently
 * published in the registry. Authors use this to discover identifiers when
 * filling in `depends`, `recommends`, `suggests`, `provides`, etc.
 *
 * Selecting a card opens a drawer with full details and a copy-to-clipboard
 * button on the identifier.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ActionIcon, Alert, Anchor, Autocomplete, Avatar, Badge, Button, Checkbox, CloseButton, Collapse,
  Container, CopyButton, Divider, Drawer, Grid, Group, Image, Loader, Modal, MultiSelect, Paper,
  Rating, ScrollArea, SegmentedControl, Select, SimpleGrid, Slider, Stack, Text, Textarea, TextInput,
  Title, Tooltip, UnstyledButton,
} from '@mantine/core'
import { useDebouncedValue, useDisclosure } from '@mantine/hooks'
import { api, ApiError, type OwnerInfo, type User } from '../api/client'
import { useSubmitDraft } from '../state/SubmitDraftContext'
import {
  ClaimedByBadge, formatRelativeTime, initialsOf, isHttpUrl, KIND_LABEL,
  LastEditedBadge, ModCard, RatingBadge,
  type LastEdit, type RatingInfo,
} from '../components/ModCard'
import { Seo } from '../components/Seo'

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
  rating: RatingInfo
  owner: OwnerInfo | null
}

interface FacetEntry { value: string; count: number }

interface ModListResponse {
  items: ModListItem[]
  total: number
  page: number
  pageSize: number
  facets: {
    mod_types: Record<string, number>
    kinds?: Record<string, number>
    licenses?: Record<string, number>
    statuses?: Record<string, number>
    multiplayer?: Record<string, number>
    verified?: { true: number; false: number }
    tags?: FacetEntry[]
    authors?: FacetEntry[]
  }
}

/** Fields available to the `has:` presence filter. */
const HAS_FIELDS: { value: string; label: string }[] = [
  { value: 'download', label: 'Download URL' },
  { value: 'thumbnail', label: 'Thumbnail' },
  { value: 'repository', label: 'Repository link' },
  { value: 'homepage', label: 'Homepage link' },
  { value: 'bugtracker', label: 'Bug tracker' },
  { value: 'beamng_resource', label: 'BeamNG.com page' },
  { value: 'depends', label: 'Has dependencies' },
  { value: 'provides', label: 'Provides slot' },
]

const SORT_OPTIONS = [
  { value: 'default', label: 'Verified first, then name' },
  { value: 'name', label: 'Name (A→Z)' },
  { value: '-name', label: 'Name (Z→A)' },
  { value: 'identifier', label: 'Identifier (A→Z)' },
  { value: '-identifier', label: 'Identifier (Z→A)' },
  { value: '-rating', label: 'Highest rated' },
  { value: 'rating', label: 'Lowest rated' },
  { value: 'recent', label: 'Latest version' },
]

interface ModDetail extends ModListItem {
  raw: Record<string, unknown>
}

interface ModDetailResponse {
  mod: ModDetail
  watch?: { kref?: string; filter_asset?: string }
  last_edit: LastEdit | null
  rating: RatingInfo
  owner: OwnerInfo | null
}

const PAGE_SIZE = 24

export function RegistryBrowserPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  // ── Filter state ──────────────────────────────────────────────────────
  // All filter state is mirrored to the URL so the page is shareable and
  // bookmarkable. Initialised from the current URL on mount.
  const [q, setQ] = useState(searchParams.get('q') ?? '')
  const [debouncedQ] = useDebouncedValue(q, 250)
  const [type, setType] = useState<string | null>(searchParams.get('type'))
  const [kind, setKind] = useState<string | null>(searchParams.get('kind'))
  const [status, setStatus] = useState<string | null>(searchParams.get('status'))
  const [multiplayer, setMultiplayer] = useState<string | null>(searchParams.get('multiplayer'))
  const [license, setLicense] = useState<string | null>(searchParams.get('license'))
  const [author, setAuthor] = useState<string>(searchParams.get('author') ?? '')
  const [debouncedAuthor] = useDebouncedValue(author, 250)
  const [activeTags, setActiveTags] = useState<string[]>(
    (searchParams.get('tags') ?? '').split(',').filter(Boolean),
  )
  const [tagMode, setTagMode] = useState<'all' | 'any'>(
    (searchParams.get('tag_mode') as 'all' | 'any') ?? 'all',
  )
  const [verified, setVerified] = useState<string>(searchParams.get('verified') ?? 'any')
  const [hasFields, setHasFields] = useState<string[]>(
    (searchParams.get('has') ?? '').split(',').filter(Boolean),
  )
  const [minRating, setMinRating] = useState<number>(
    Number(searchParams.get('min_rating') ?? '0') || 0,
  )
  const [sort, setSort] = useState<string>(searchParams.get('sort') ?? 'default')
  const [advancedOpen, advancedToggle] = useDisclosure(
    // Auto-expand if any advanced filter is already active in the URL.
    Boolean(
      searchParams.get('kind') || searchParams.get('status') || searchParams.get('multiplayer') ||
      searchParams.get('license') || searchParams.get('author') || searchParams.get('tags') ||
      searchParams.get('verified') || searchParams.get('has') || searchParams.get('min_rating') ||
      (searchParams.get('sort') && searchParams.get('sort') !== 'default'),
    ),
  )

  const [selected, setSelectedState] = useState<string | null>(
    searchParams.get('selected'),
  )

  // Reflect current filter state back into the URL whenever any input
  // changes. Uses replace so back/forward isn't polluted.
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    const set = (key: string, value: string | null | undefined) => {
      if (value && value.length > 0) next.set(key, value)
      else next.delete(key)
    }
    set('q', debouncedQ)
    set('type', type)
    set('kind', kind)
    set('status', status)
    set('multiplayer', multiplayer)
    set('license', license)
    set('author', debouncedAuthor)
    set('tags', activeTags.join(','))
    set('tag_mode', activeTags.length > 1 && tagMode === 'any' ? 'any' : null)
    set('verified', verified === 'any' ? null : verified)
    set('has', hasFields.join(','))
    set('min_rating', minRating > 0 ? String(minRating) : null)
    set('sort', sort && sort !== 'default' ? sort : null)
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, type, kind, status, multiplayer, license, debouncedAuthor,
      activeTags, tagMode, verified, hasFields, minRating, sort])

  // Keep ?selected= in sync with the drawer state so external links (e.g. a
  // card on the dashboard) can deep-link to a specific mod, and so opening
  // a card here gives users a copyable URL.
  const setSelected = (id: string | null) => {
    setSelectedState(id)
    const next = new URLSearchParams(searchParams)
    if (id) next.set('selected', id)
    else next.delete('selected')
    setSearchParams(next, { replace: true })
  }

  // Pick up later URL changes (e.g. user pastes a different ?selected= URL)
  useEffect(() => {
    const param = searchParams.get('selected')
    if (param !== selected) setSelectedState(param)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Infinite scroll: each page returns PAGE_SIZE items; we fetch the next
  // page when the sentinel scrolls into view. Filter changes reset the
  // scroll automatically because the query key changes.
  const list = useInfiniteQuery({
    queryKey: ['mods', {
      q: debouncedQ, type, kind, status, multiplayer, license,
      author: debouncedAuthor, tags: activeTags, tagMode, verified,
      has: hasFields, minRating, sort,
    }],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      if (debouncedQ) params.set('q', debouncedQ)
      if (type) params.set('type', type)
      if (kind) params.set('kind', kind)
      if (status) params.set('status', status)
      if (multiplayer) params.set('multiplayer', multiplayer)
      if (license) params.set('license', license)
      if (debouncedAuthor.trim()) params.set('author', debouncedAuthor.trim())
      if (activeTags.length > 0) {
        params.set('tags', activeTags.join(','))
        if (activeTags.length > 1) params.set('tag_mode', tagMode)
      }
      if (verified !== 'any') params.set('verified', verified)
      if (hasFields.length > 0) params.set('has', hasFields.join(','))
      if (minRating > 0) params.set('min_rating', String(minRating))
      if (sort && sort !== 'default') params.set('sort', sort)
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

  // Build option lists for each filter dropdown from the server-provided
  // facet counts, sorted by frequency. Memoised against the latest page so
  // counts stay fresh as the registry index updates.
  const facetOptions = (counts: Record<string, number> | undefined) =>
    Object.entries(counts ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: `${value} (${count})` }))

  const typeOptions = useMemo(() => facetOptions(facets.mod_types), [facets])
  const kindOptions = useMemo(() => facetOptions(facets.kinds), [facets])
  const statusOptions = useMemo(() => facetOptions(facets.statuses), [facets])
  const multiplayerOptions = useMemo(() => facetOptions(facets.multiplayer), [facets])
  const licenseOptions = useMemo(() => facetOptions(facets.licenses), [facets])
  const tagOptions = useMemo(
    () => (facets.tags ?? []).map((t) => ({ value: t.value, label: `${t.value} (${t.count})` })),
    [facets],
  )
  const authorSuggestions = useMemo(
    () => (facets.authors ?? []).map((a) => a.value),
    [facets],
  )

  const activeFilterCount =
    (type ? 1 : 0) + (kind ? 1 : 0) + (status ? 1 : 0) + (multiplayer ? 1 : 0) +
    (license ? 1 : 0) + (debouncedAuthor.trim() ? 1 : 0) + activeTags.length +
    (verified !== 'any' ? 1 : 0) + hasFields.length + (minRating > 0 ? 1 : 0) +
    (sort && sort !== 'default' ? 1 : 0)

  const resetFilters = () => {
    setQ('')
    setType(null); setKind(null); setStatus(null); setMultiplayer(null); setLicense(null)
    setAuthor(''); setActiveTags([]); setTagMode('all'); setVerified('any')
    setHasFields([]); setMinRating(0); setSort('default')
  }

  const removeTag = (t: string) => setActiveTags(activeTags.filter((x) => x !== t))
  const removeHas = (h: string) => setHasFields(hasFields.filter((x) => x !== h))

  return (
    <Container size={1200}>
      <Seo
        title="BeamNG Mod Registry Browser for BeamMP and CareerMP Servers"
        description="Search verified BeamNG mods by type, compatibility, and metadata to build reliable BeamMP and CareerMP server-ready mod packs."
        canonicalPath="/registry"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: 'BeamNG Mod Registry Browser',
          description: 'Searchable index of BeamNG mods with compatibility metadata for BeamMP and CareerMP server setups.',
          url: `${window.location.origin}/registry`,
        }}
      />
      <Group justify="space-between" align="flex-end" mb="md">
        <Title order={2}>Registry browser</Title>
        {list.data && (
          <Text c="dimmed" size="sm">
            {total.toLocaleString()} mod{total === 1 ? '' : 's'} indexed
          </Text>
        )}
      </Group>

      <Paper withBorder p="md" radius="md" mb="md">
        <Text size="sm">
          Planning multiplayer? Use this page to assemble compatible packs for a{' '}
          <Anchor component={Link} to="/faq">BeamMP server</Anchor>
          {' '}or{' '}
          <Anchor component={Link} to="/faq">CareerMP server</Anchor>
          . Install faster with{' '}
          <Anchor component={Link} to="/content-manager">BeamNG Content Manager</Anchor>.
        </Text>
      </Paper>

      <Paper withBorder p="md" radius="md" mb="md">
        <Stack gap="sm">
          <Group wrap="wrap" gap="sm" align="flex-end">
            <TextInput
              label="Search"
              placeholder="Name, identifier, author, abstract, tag…"
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              style={{ flex: 1, minWidth: 240 }}
              rightSection={
                q ? <CloseButton onClick={() => setQ('')} /> : null
              }
            />
            <Select
              label="Mod type"
              placeholder="All types"
              value={type}
              onChange={(v) => setType(v)}
              data={typeOptions}
              clearable
              searchable
              w={200}
            />
            <Select
              label="Sort"
              value={sort}
              onChange={(v) => setSort(v ?? 'default')}
              data={SORT_OPTIONS}
              w={220}
              allowDeselect={false}
            />
            <Button
              variant={advancedOpen ? 'filled' : 'light'}
              onClick={advancedToggle.toggle}
              color="grape"
            >
              Advanced filters
              {activeFilterCount > 0 && (
                <Badge ml={6} size="sm" circle color="grape" variant="white">
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
            {activeFilterCount > 0 && (
              <Button variant="subtle" color="gray" onClick={resetFilters}>
                Reset
              </Button>
            )}
          </Group>

          <Collapse in={advancedOpen}>
            <Stack gap="sm" pt="xs">
              <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="sm">
                <Select
                  label="Kind"
                  placeholder="Any"
                  value={kind}
                  onChange={setKind}
                  data={kindOptions}
                  clearable
                  searchable
                />
                <Select
                  label="Release status"
                  placeholder="Any"
                  value={status}
                  onChange={setStatus}
                  data={statusOptions}
                  clearable
                />
                <Select
                  label="Multiplayer scope"
                  placeholder="Any"
                  value={multiplayer}
                  onChange={setMultiplayer}
                  data={multiplayerOptions}
                  clearable
                />
                <Select
                  label="License"
                  placeholder="Any"
                  value={license}
                  onChange={setLicense}
                  data={licenseOptions}
                  clearable
                  searchable
                />
                <Autocomplete
                  label="Author contains"
                  placeholder="e.g. BeamNG"
                  value={author}
                  onChange={setAuthor}
                  data={authorSuggestions}
                  limit={10}
                />
                <Select
                  label="Verified"
                  value={verified}
                  onChange={(v) => setVerified(v ?? 'any')}
                  data={[
                    { value: 'any', label: 'Any' },
                    {
                      value: 'true',
                      label: `Verified only${facets.verified ? ` (${facets.verified.true})` : ''}`,
                    },
                    {
                      value: 'false',
                      label: `Unverified only${facets.verified ? ` (${facets.verified.false})` : ''}`,
                    },
                  ]}
                  allowDeselect={false}
                />
              </SimpleGrid>

              <MultiSelect
                label="Tags"
                placeholder={activeTags.length === 0 ? 'Pick or type tags…' : ''}
                value={activeTags}
                onChange={setActiveTags}
                data={tagOptions}
                searchable
                clearable
                hidePickedOptions
                maxDropdownHeight={280}
                rightSection={
                  activeTags.length > 1 ? (
                    <SegmentedControl
                      size="xs"
                      value={tagMode}
                      onChange={(v) => setTagMode(v as 'all' | 'any')}
                      data={[
                        { value: 'all', label: 'All' },
                        { value: 'any', label: 'Any' },
                      ]}
                    />
                  ) : null
                }
                rightSectionWidth={activeTags.length > 1 ? 140 : 36}
                description={
                  activeTags.length > 1
                    ? `Match mods that have ${tagMode === 'all' ? 'all' : 'any'} of these tags`
                    : undefined
                }
              />

              <Stack gap={4}>
                <Text size="sm" fw={500}>Must include</Text>
                <Checkbox.Group value={hasFields} onChange={setHasFields}>
                  <Group gap="md" wrap="wrap">
                    {HAS_FIELDS.map((f) => (
                      <Checkbox key={f.value} value={f.value} label={f.label} />
                    ))}
                  </Group>
                </Checkbox.Group>
              </Stack>

              <Stack gap={4}>
                <Group justify="space-between">
                  <Text size="sm" fw={500}>Minimum rating</Text>
                  <Group gap={6}>
                    <Rating value={minRating} onChange={setMinRating} fractions={2} />
                    {minRating > 0 && (
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        onClick={() => setMinRating(0)}
                        title="Clear rating filter"
                      >
                        <CloseButton size="xs" />
                      </ActionIcon>
                    )}
                  </Group>
                </Group>
              </Stack>
            </Stack>
          </Collapse>

          {/* Active filter chips — quick removal of any filter without
              opening the advanced panel. */}
          {activeFilterCount > 0 && (
            <Group gap={6} wrap="wrap">
              {type && (
                <Badge color="blue" variant="light" rightSection={<CloseButton size="xs" onClick={() => setType(null)} />}>
                  type: {type}
                </Badge>
              )}
              {kind && (
                <Badge color="blue" variant="light" rightSection={<CloseButton size="xs" onClick={() => setKind(null)} />}>
                  kind: {kind}
                </Badge>
              )}
              {status && (
                <Badge color="blue" variant="light" rightSection={<CloseButton size="xs" onClick={() => setStatus(null)} />}>
                  status: {status}
                </Badge>
              )}
              {multiplayer && (
                <Badge color="blue" variant="light" rightSection={<CloseButton size="xs" onClick={() => setMultiplayer(null)} />}>
                  mp: {multiplayer}
                </Badge>
              )}
              {license && (
                <Badge color="blue" variant="light" rightSection={<CloseButton size="xs" onClick={() => setLicense(null)} />}>
                  license: {license}
                </Badge>
              )}
              {debouncedAuthor.trim() && (
                <Badge color="blue" variant="light" rightSection={<CloseButton size="xs" onClick={() => setAuthor('')} />}>
                  author: {debouncedAuthor.trim()}
                </Badge>
              )}
              {verified !== 'any' && (
                <Badge color="green" variant="light" rightSection={<CloseButton size="xs" onClick={() => setVerified('any')} />}>
                  {verified === 'true' ? 'verified only' : 'unverified only'}
                </Badge>
              )}
              {activeTags.map((t) => (
                <Badge key={t} color="grape" variant="light" rightSection={<CloseButton size="xs" onClick={() => removeTag(t)} />}>
                  #{t}
                </Badge>
              ))}
              {hasFields.map((h) => (
                <Badge key={h} color="teal" variant="light" rightSection={<CloseButton size="xs" onClick={() => removeHas(h)} />}>
                  has: {h}
                </Badge>
              ))}
              {minRating > 0 && (
                <Badge color="yellow" variant="light" rightSection={<CloseButton size="xs" onClick={() => setMinRating(0)} />}>
                  ≥ {minRating}★
                </Badge>
              )}
              {sort && sort !== 'default' && (
                <Badge color="gray" variant="light" rightSection={<CloseButton size="xs" onClick={() => setSort('default')} />}>
                  sort: {SORT_OPTIONS.find((o) => o.value === sort)?.label ?? sort}
                </Badge>
              )}
            </Group>
          )}
        </Stack>
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
            <ModCard mod={m} onClick={() => setSelected(m.identifier)} />
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
            rating={detail.data.rating}
            owner={detail.data.owner}
            onClose={() => setSelected(null)}
          />
        )}
      </Drawer>
    </Container>
  )
}

function ModDetailView({ mod, watch, lastEdit, rating, owner, onClose }: { mod: ModDetail; watch?: { kref?: string; filter_asset?: string }; lastEdit: LastEdit | null; rating: RatingInfo; owner: OwnerInfo | null; onClose: () => void }) {
  const draft = useSubmitDraft()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [historyOpen, historyToggle] = useDisclosure(false)

  // Detect signed-in viewer; gates rating + claim + propose-edit actions.
  const me = useQuery<{ user: User | null }>({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/auth/me'),
  })
  const viewer = me.data?.user ?? null

  // History is fetched lazily the first time the user expands the dropdown
  // so we don't pay for it on every drawer open.
  const history = useQuery<{ history: LastEdit[] }>({
    queryKey: ['mod-history', mod.identifier],
    queryFn: () => api.get<{ history: LastEdit[] }>(`/mods/${encodeURIComponent(mod.identifier)}/history`),
    enabled: historyOpen,
  })

  // Local rating state so the UI reflects the user's choice immediately
  // while the mutation is in flight.
  const [localRating, setLocalRating] = useState<RatingInfo>(rating)
  useEffect(() => { setLocalRating(rating) }, [rating])

  function patchListCaches(next: RatingInfo) {
    // Update every cached /mods page that contains this identifier so the
    // grid card reflects the new aggregate without a full refetch.
    queryClient.setQueriesData<{ pages?: ModListResponse[] } | undefined>(
      { queryKey: ['mods'] },
      (old) => {
        if (!old?.pages) return old
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((it) =>
              it.identifier === mod.identifier ? { ...it, rating: next } : it,
            ),
          })),
        }
      },
    )
    // Also patch the detail cache so re-opening the drawer is consistent.
    queryClient.setQueryData<ModDetailResponse | undefined>(
      ['mod', mod.identifier],
      (old) => (old ? { ...old, rating: next } : old),
    )
  }

  const setRating = useMutation({
    mutationFn: (stars: number) =>
      api.put<{ rating: RatingInfo }>(`/mods/${encodeURIComponent(mod.identifier)}/rating`, { stars }),
    onSuccess: (data) => {
      setLocalRating(data.rating)
      patchListCaches(data.rating)
    },
  })

  const clearRating = useMutation({
    mutationFn: () =>
      api.delete<{ rating: RatingInfo }>(`/mods/${encodeURIComponent(mod.identifier)}/rating`),
    onSuccess: (data) => {
      setLocalRating(data.rating)
      patchListCaches(data.rating)
    },
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

      <OwnershipPanel mod={mod} owner={owner} />

      <Paper withBorder p="sm" radius="sm">
        <Stack gap={6}>
          <Group justify="space-between" align="center" wrap="wrap">
            <Stack gap={2}>
              <Text size="sm" fw={600}>{viewer ? 'Your rating' : 'Ratings'}</Text>
              <Text size="xs" c="dimmed">
                {localRating.count === 0
                  ? (viewer ? 'No ratings yet — be the first.' : 'No ratings yet.')
                  : `Average ${localRating.avg.toFixed(1)} from ${localRating.count} rating${localRating.count === 1 ? '' : 's'}.`}
              </Text>
            </Stack>
            <Group gap={6} wrap="nowrap" align="center">
              <Rating
                value={viewer ? (localRating.mine ?? 0) : Math.round(localRating.avg)}
                onChange={(v) => {
                  if (!viewer) return
                  setLocalRating({ ...localRating, mine: v })
                  setRating.mutate(v)
                }}
                readOnly={!viewer || setRating.isPending || clearRating.isPending}
                fractions={viewer ? 1 : 2}
              />
              {viewer && localRating.mine ? (
                <Tooltip label="Clear your rating" withArrow>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => clearRating.mutate()}
                    disabled={setRating.isPending || clearRating.isPending}
                    aria-label="Clear rating"
                  >
                    ✕
                  </ActionIcon>
                </Tooltip>
              ) : null}
            </Group>
          </Group>
          {!viewer && (
            <Text size="xs" c="dimmed">
              <Anchor component={Link} to="/login">Sign in</Anchor> to rate this mod.
            </Text>
          )}
          {(setRating.isError || clearRating.isError) && (
            <Text size="xs" c="red">Failed to save rating. Try again.</Text>
          )}
        </Stack>
      </Paper>

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
          <Group gap="xs" align="center">
            <Button size="xs" variant="light" disabled={!viewer} onClick={() => proposeEdit(false)}>
              Propose edit
            </Button>
            {!viewer && (
              <Text size="xs" c="dimmed">
                (<Anchor component={Link} to="/login">sign in</Anchor> to propose edits)
              </Text>
            )}
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
          <Group gap="xs" align="center">
            <Button size="xs" disabled={!viewer} onClick={() => proposeEdit(true)}>
              Submit new version
            </Button>
            {!viewer && (
              <Text size="xs" c="dimmed">
                (<Anchor component={Link} to="/login">sign in</Anchor> to submit)
              </Text>
            )}
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

/**
 * Ownership panel shown in the mod detail drawer. If the mod is unowned and
 * the viewer is signed in, exposes a "Claim this mod" button that opens a
 * modal to submit a claim (queued for green-tier reviewer approval).
 */
function OwnershipPanel({ mod, owner }: { mod: ModDetail; owner: OwnerInfo | null }) {
  const me = useQuery<{ user: User | null }>({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/auth/me'),
  })
  const queryClient = useQueryClient()
  const [opened, { open, close }] = useDisclosure(false)
  const [message, setMessage] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)

  const claim = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/submissions/claim', {
        identifier: mod.identifier,
        message: message.trim() || undefined,
      }),
    onSuccess: () => {
      setMessage('')
      setSubmitError(null)
      close()
      queryClient.invalidateQueries({ queryKey: ['mod', mod.identifier] })
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        const body = err.body as { error?: string } | string | null
        const code = typeof body === 'object' && body && 'error' in body ? body.error : String(body ?? err.message)
        setSubmitError(code ?? 'claim_failed')
      } else {
        setSubmitError('claim_failed')
      }
    },
  })

  const user = me.data?.user ?? null
  const isOwner = !!owner && !!user && owner.user_id === user.id

  if (owner) {
    return (
      <Paper withBorder p="sm" radius="sm">
        <Stack gap={6}>
          <Text size="sm" fw={600}>Ownership</Text>
          <ClaimedByBadge owner={owner} />
          {isOwner && (
            <Text size="xs" c="dimmed">
              You own this mod. Other authors&apos; edits to it will be routed to you for approval.
            </Text>
          )}
        </Stack>
      </Paper>
    )
  }

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap={6}>
        <Text size="sm" fw={600}>Ownership</Text>
        <Text size="xs" c="dimmed">
          This mod is unclaimed. If you&apos;re the original author, claim it so future
          edits route to you for approval before publishing.
        </Text>
        <Group gap="xs">
          <Button
            size="xs"
            variant="light"
            disabled={!user}
            onClick={open}
          >
            Claim this mod
          </Button>
          {!user && <Text size="xs" c="dimmed">(sign in to claim)</Text>}
        </Group>
      </Stack>

      <Modal opened={opened} onClose={close} title={`Claim ${mod.identifier}`} centered>
        <Stack gap="sm">
          <Text size="sm">
            A green-tier reviewer will be notified and asked to confirm you are the
            author. Once approved, you will own this mod and any future edits by
            other users will require your approval before being published.
          </Text>
          <Textarea
            label="Message to reviewer (optional)"
            description="Anything that helps confirm authorship — links, context, etc."
            value={message}
            onChange={(e) => setMessage(e.currentTarget.value)}
            minRows={3}
            autosize
          />
          {submitError && (
            <Alert color="red" variant="light">
              {submitError === 'already_owned' && 'This mod has already been claimed.'}
              {submitError === 'claim_already_pending' && 'You already have a pending claim for this mod.'}
              {submitError === 'mod_not_found' && 'This mod is not in the registry yet.'}
              {!['already_owned','claim_already_pending','mod_not_found'].includes(submitError) && submitError}
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" size="xs" onClick={close} disabled={claim.isPending}>Cancel</Button>
            <Button size="xs" loading={claim.isPending} onClick={() => claim.mutate()}>Submit claim</Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  )
}


