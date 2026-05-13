/**
 * Public-facing directory of alternative BeamMP backends.
 *
 * Operators of decentralized BeamMP backends (e.g. Decentralized-BMP-V2)
 * publish heartbeats to `/api/backends/heartbeat` using a token issued by
 * an admin. This page renders whichever entries are currently live (last
 * heartbeat within ~3 minutes) so that:
 *   - End users can browse alternative backends, and
 *   - Content Manager can fetch the same JSON to populate its backend
 *     dropdown (no auth required for the public list).
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Alert, Badge, Button, Card, Code, Collapse, Container, Group, Loader,
  Stack, Table, Text, TextInput, Title,
} from '@mantine/core'
import { api } from '../api/client'
import { Seo } from '../components/Seo'
import { BeamMPText, stripBeamMP } from '../components/BeamMPText'

interface BackendBuilds {
  server_windows?: string
  server_linux?: string
  launcher?: string
  client?: string
}

interface BackendListItem {
  id: number
  url: string
  name: string
  region: string
  description: string
  launcher_version: string
  server_version: string
  active_servers: number
  active_players: number
  last_seen_at: number
  builds: BackendBuilds
}

interface BackendServer {
  name: string
  players: number
  max_players: number
  map: string
  ip: string
  port: number
}

interface BackendDetail extends BackendListItem {
  first_seen_at: number
  servers: BackendServer[]
}

function ageLabel(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}

/**
 * Friendlier rendering of BeamMP server map paths like
 * `/levels/east_coast_usa/info.json` -> `East Coast Usa`. Falls back to the
 * raw value if it doesn't match the standard `/levels/<id>/info.json` shape.
 */
function prettyMapName(map: string): string {
  if (!map) return '—'
  const id = map.replace(/^\/levels\//, '').replace(/\/info\.json$/, '').replace(/\/$/, '')
  if (!id) return map
  return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function BuildLinks({ builds }: { builds: BackendBuilds }) {
  const entries: Array<[string, string | undefined]> = [
    ['Server (Windows)', builds.server_windows],
    ['Server (Linux)', builds.server_linux],
    ['Launcher', builds.launcher],
    ['Client mod', builds.client],
  ]
  const present = entries.filter(([, v]) => v)
  if (present.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        This backend doesn't publish modified server / launcher binaries.
      </Text>
    )
  }
  return (
    <Group gap="xs">
      {present.map(([label, href]) => (
        <Button
          key={label}
          component="a"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          size="xs"
          variant="light"
        >
          {label}
        </Button>
      ))}
    </Group>
  )
}

function BackendCard({ b }: { b: BackendListItem }) {
  const [open, setOpen] = useState(false)
  const detail = useQuery({
    queryKey: ['backend', b.id],
    queryFn: () => api.get<BackendDetail>(`/backends/${b.id}`),
    enabled: open,
    refetchInterval: open ? 30_000 : false,
  })

  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2}>
            <Group gap="xs">
              <Text fw={600}><BeamMPText text={b.name} /></Text>
              {b.region && <Badge variant="light">{b.region}</Badge>}
            </Group>
            <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>{b.url}</Text>
            {b.description && <Text size="sm" mt={4}>{b.description}</Text>}
          </Stack>
          <Stack gap={2} align="flex-end">
            <Badge color="green" variant="light">
              {b.active_players} player{b.active_players === 1 ? '' : 's'}
            </Badge>
            <Text size="xs" c="dimmed">
              {b.active_servers} server{b.active_servers === 1 ? '' : 's'}
            </Text>
            <Text size="xs" c="dimmed">heartbeat {ageLabel(b.last_seen_at)}</Text>
          </Stack>
        </Group>

        {(b.launcher_version || b.server_version) && (
          <Group gap="xs">
            {b.server_version && (
              <Badge variant="outline" color="gray">server {b.server_version}</Badge>
            )}
            {b.launcher_version && (
              <Badge variant="outline" color="gray">launcher {b.launcher_version}</Badge>
            )}
          </Group>
        )}

        <BuildLinks builds={b.builds} />

        <Group justify="space-between">
          <Button
            size="xs"
            variant="subtle"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide live servers' : `Show live servers (${b.active_servers})`}
          </Button>
          <Group gap="xs">
            <Button
              component="a"
              href={`${b.url.replace(/\/$/, '')}/`}
              target="_blank"
              rel="noopener noreferrer"
              size="xs"
              variant="light"
            >
              Open backend
            </Button>
          </Group>
        </Group>

        <Collapse in={open}>
          {detail.isLoading && <Loader size="sm" />}
          {detail.isError && <Alert color="red">Failed to load server list.</Alert>}
          {detail.data && detail.data.servers.length === 0 && (
            <Text size="sm" c="dimmed">No live servers right now.</Text>
          )}
          {detail.data && detail.data.servers.length > 0 && (
            <>
              <Alert color="blue" variant="light" mb="xs">
                To join one of these servers, open <b>BeamNG Content Manager</b>
                and go to <b>Settings → Backend</b>. This backend
                (<Code>{b.name}</Code>) is published, so it should appear in
                the dropdown automatically — just pick it. If it doesn't,
                paste <Code>{b.url}</Code> into the <i>Custom backend</i>
                field. Then open the <b>Servers</b> page and connect as normal.
              </Alert>
              <Table striped withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Server name</Table.Th>
                    <Table.Th>Map</Table.Th>
                    <Table.Th>Players</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {detail.data.servers.map((s, i) => {
                    // Some backends echo their own display name back in the
                    // per-server entry when the BeamMP server hasn't set one.
                    // Compare with formatting codes stripped so e.g.
                    // "^6^lFoo" still matches "Foo".
                    const cleanServer = stripBeamMP(s.name || '').trim()
                    const cleanBackend = stripBeamMP(b.name || '').trim()
                    const isPlaceholder = !cleanServer || cleanServer === cleanBackend
                    return (
                      <Table.Tr key={`${s.ip}:${s.port}:${i}`}>
                        <Table.Td>
                          {isPlaceholder
                            ? <Text c="dimmed" span>(unnamed server)</Text>
                            : <BeamMPText text={s.name} />}
                        </Table.Td>
                        <Table.Td>{prettyMapName(s.map)}</Table.Td>
                        <Table.Td>{s.players}/{s.max_players}</Table.Td>
                      </Table.Tr>
                    )
                  })}
                </Table.Tbody>
              </Table>
            </>
          )}
        </Collapse>
      </Stack>
    </Card>
  )
}

export function BackendsPage() {
  const list = useQuery({
    queryKey: ['backends'],
    queryFn: () => api.get<{ backends: BackendListItem[] }>('/backends'),
    refetchInterval: 60_000,
  })

  const [filter, setFilter] = useState('')

  const backends = list.data?.backends ?? []
  const filtered = filter.trim()
    ? backends.filter((b) => {
        const q = filter.toLowerCase()
        // Strip BeamMP color/style codes from the display name so e.g.
        // searching "musanet" still matches "^6^lMusanet ..." entries.
        return (
          stripBeamMP(b.name).toLowerCase().includes(q) ||
          b.url.toLowerCase().includes(q) ||
          b.region.toLowerCase().includes(q) ||
          b.description.toLowerCase().includes(q)
        )
      })
    : backends

  return (
    <Container size={900}>
      <Seo
        title="Alternative BeamMP backends"
        description="Public directory of decentralized BeamMP backends operators can host themselves and Content Manager can connect to."
        canonicalPath="/backends"
      />
      <Stack>
        <Group justify="space-between" align="flex-end">
          <div>
            <Title order={2}>Alternative BeamMP backends</Title>
            <Text c="dimmed" size="sm" mt={4}>
              Decentralized backends that have published a heartbeat in the last
              few minutes. Content Manager pulls this same list to populate its
              backend dropdown — selecting one points your launcher and any
              servers you host at that operator instead of <Code>backend.beammp.com</Code>.
            </Text>
          </div>
          <Badge size="lg" variant="light">
            {backends.length} live
          </Badge>
        </Group>

        <TextInput
          placeholder="Filter by name, region, or URL"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />

        {list.isLoading && <Loader />}
        {list.isError && <Alert color="red">Failed to load backends.</Alert>}
        {list.data && filtered.length === 0 && (
          <Alert color="gray" variant="light">
            {backends.length === 0
              ? 'No backends are publishing right now.'
              : 'No backends match that filter.'}
          </Alert>
        )}
        {filtered.map((b) => <BackendCard key={b.id} b={b} />)}

        <Text c="dimmed" size="xs" mt="lg">
          Operators: install <Code>Decentralized-BMP-V2</Code>, get a publish
          token from a registry admin, set <Code>BMR_API_KEY</Code> in your{' '}
          <Code>.env</Code>, and toggle <em>Publish</em> on. Your backend
          appears here within a minute.
        </Text>
      </Stack>
    </Container>
  )
}
