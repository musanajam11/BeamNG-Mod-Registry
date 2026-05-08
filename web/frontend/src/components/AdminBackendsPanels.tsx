/**
 * Backend-token admin panels. Lives under the Admin → Backends tab. The
 * "tokens" panel mints/revokes tokens directly; the "requests" panel
 * approves/denies user-submitted token requests (which mints a token under
 * the requester's name).
 *
 * These used to live on the Admin → Settings page. They moved here because
 * "settings" is for configuration (GitHub app, theme, Turnstile) and
 * issuing operator credentials is an operational/admin action.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert, Badge, Button, Divider, Group, Paper, Stack, Text, TextInput, Title,
} from '@mantine/core'
import { ApiError, api } from '../api/client'

interface BackendTokenRow {
  id: number
  label: string
  created_at: number
  created_by: number | null
  revoked_at: number | null
  last_used_at: number | null
}

export function BackendTokensPanel() {
  const qc = useQueryClient()
  const tokens = useQuery({
    queryKey: ['admin', 'backend-tokens'],
    queryFn: () => api.get<{ tokens: BackendTokenRow[] }>('/admin/backend-tokens'),
  })
  const [label, setLabel] = useState('')
  const [issued, setIssued] = useState<{ id: number; label: string; token: string } | null>(null)

  const mint = useMutation({
    mutationFn: (newLabel: string) =>
      api.post<{ id: number; label: string; token: string }>('/admin/backend-tokens', { label: newLabel }),
    onSuccess: (data) => {
      setIssued(data)
      setLabel('')
      qc.invalidateQueries({ queryKey: ['admin', 'backend-tokens'] })
    },
  })

  const revoke = useMutation({
    mutationFn: (id: number) => api.delete<{ ok: true }>(`/admin/backend-tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'backend-tokens'] }),
  })

  const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : '—')
  const rows = tokens.data?.tokens ?? []

  return (
    <Paper withBorder p="lg" radius="md" mt="xl">
      <Stack>
        <Group justify="space-between">
          <Title order={4}>Backend tokens</Title>
          <Badge variant="light">{rows.filter((r) => !r.revoked_at).length} active</Badge>
        </Group>
        <Text c="dimmed" size="sm">
          Each token authenticates a single decentralized BeamMP backend (e.g. a{' '}
          <code>Decentralized-BMP-V2</code> instance) when it POSTs heartbeats
          to <code>/api/backends/heartbeat</code>. Operators paste the token
          into their <code>BMR_API_KEY</code> env var. Tokens minted here are
          shown in plaintext exactly once — store them somewhere safe.
        </Text>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            const trimmed = label.trim()
            if (trimmed) mint.mutate(trimmed)
          }}
        >
          <Group align="flex-end">
            <TextInput
              label="Label"
              placeholder="e.g. musa-vps-fra"
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              style={{ flex: 1 }}
              required
            />
            <Button type="submit" loading={mint.isPending}>Mint token</Button>
          </Group>
        </form>

        {mint.isError && (
          <Alert color="red">
            {mint.error instanceof ApiError ? JSON.stringify(mint.error.body) : 'Mint failed'}
          </Alert>
        )}

        {issued && (
          <Alert color="green" title={`Token for "${issued.label}"`} withCloseButton onClose={() => setIssued(null)}>
            <Stack gap="xs">
              <Text size="sm">
                Copy this now — it will not be shown again. The operator pastes
                it into <code>BMR_API_KEY</code>.
              </Text>
              <code
                style={{
                  display: 'block',
                  padding: 8,
                  background: 'var(--mantine-color-dark-7, #111)',
                  color: 'var(--mantine-color-gray-0, #fff)',
                  borderRadius: 4,
                  wordBreak: 'break-all',
                }}
              >
                {issued.token}
              </code>
              <Group>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => navigator.clipboard?.writeText(issued.token)}
                >
                  Copy
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}

        <Divider />

        {tokens.isLoading && <Text c="dimmed" size="sm">Loading…</Text>}
        {tokens.isError && <Alert color="red">Failed to load tokens.</Alert>}
        {tokens.data && rows.length === 0 && (
          <Text c="dimmed" size="sm">No tokens issued yet.</Text>
        )}
        {rows.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--mantine-color-dark-4, #444)' }}>
                <th style={{ padding: '6px 8px' }}>Label</th>
                <th style={{ padding: '6px 8px' }}>Created</th>
                <th style={{ padding: '6px 8px' }}>Last used</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px' }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--mantine-color-dark-5, #333)' }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.label}</td>
                  <td style={{ padding: '6px 8px' }}>{fmt(r.created_at)}</td>
                  <td style={{ padding: '6px 8px' }}>{fmt(r.last_used_at)}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {r.revoked_at
                      ? <Badge color="red" size="sm">revoked {fmt(r.revoked_at)}</Badge>
                      : <Badge color="green" size="sm">active</Badge>}
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                    {!r.revoked_at && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        loading={revoke.isPending && revoke.variables === r.id}
                        onClick={() => {
                          if (confirm(`Revoke token "${r.label}"? Its backend will disappear from the public list immediately.`)) {
                            revoke.mutate(r.id)
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Stack>
    </Paper>
  )
}

interface BackendTokenRequestRow {
  id: number
  user_id: number
  user_email: string | null
  user_display_name: string | null
  label: string
  url: string
  region: string
  description: string
  message: string
  status: 'pending' | 'approved' | 'denied'
  deny_reason: string
  requested_at: number
  reviewed_at: number | null
  reviewer_display_name: string | null
  token_available: boolean
  token_revealed: boolean
}

export function BackendTokenRequestsPanel() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'denied'>('pending')
  const requests = useQuery({
    queryKey: ['admin', 'backend-token-requests', filter],
    queryFn: () =>
      api.get<{ requests: BackendTokenRequestRow[] }>(
        filter === 'all'
          ? '/admin/backend-token-requests'
          : `/admin/backend-token-requests?status=${filter}`
      ),
  })

  const approve = useMutation({
    mutationFn: (id: number) =>
      api.post<{ ok: true; token_id: number }>(`/admin/backend-token-requests/${id}/approve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'backend-token-requests'] })
      qc.invalidateQueries({ queryKey: ['admin', 'backend-tokens'] })
    },
  })

  const deny = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      api.post<{ ok: true }>(`/admin/backend-token-requests/${id}/deny`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'backend-token-requests'] }),
  })

  const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : '—')
  const rows = requests.data?.requests ?? []

  return (
    <Paper withBorder p="lg" radius="md">
      <Stack>
        <Group justify="space-between">
          <Title order={4}>Backend token requests</Title>
          <Group gap="xs">
            {(['pending', 'approved', 'denied', 'all'] as const).map((s) => (
              <Button
                key={s}
                size="xs"
                variant={filter === s ? 'filled' : 'subtle'}
                onClick={() => setFilter(s)}
              >
                {s}
              </Button>
            ))}
          </Group>
        </Group>
        <Text c="dimmed" size="sm">
          User-submitted requests for an operator token. Approving mints a
          token under the requester's name; the requester can then reveal
          (and re-reveal) the plaintext from their My Backends page.
        </Text>

        {requests.isLoading && <Text c="dimmed" size="sm">Loading…</Text>}
        {requests.isError && <Alert color="red">Failed to load requests.</Alert>}
        {requests.data && rows.length === 0 && (
          <Text c="dimmed" size="sm">No {filter === 'all' ? '' : filter + ' '}requests.</Text>
        )}

        {rows.map((r) => (
          <Paper key={r.id} withBorder p="md" radius="sm">
            <Stack gap="xs">
              <Group justify="space-between" align="flex-start">
                <Stack gap={2}>
                  <Group gap="xs">
                    <Text fw={600}>{r.label}</Text>
                    <Badge
                      size="sm"
                      color={r.status === 'pending' ? 'yellow' : r.status === 'approved' ? 'green' : 'red'}
                    >
                      {r.status}
                    </Badge>
                  </Group>
                  <Text size="xs" c="dimmed">
                    by {r.user_display_name || r.user_email || `user#${r.user_id}`} · {fmt(r.requested_at)}
                  </Text>
                </Stack>
                {r.status === 'pending' && (
                  <Group gap="xs">
                    <Button
                      size="xs"
                      color="green"
                      loading={approve.isPending && approve.variables === r.id}
                      onClick={() => approve.mutate(r.id)}
                    >
                      Approve
                    </Button>
                    <Button
                      size="xs"
                      color="red"
                      variant="light"
                      loading={deny.isPending && deny.variables?.id === r.id}
                      onClick={() => {
                        const reason = prompt('Deny reason (optional):') ?? ''
                        deny.mutate({ id: r.id, reason })
                      }}
                    >
                      Deny
                    </Button>
                  </Group>
                )}
              </Group>
              <Text size="sm">
                <strong>URL:</strong> <code>{r.url}</code>
                {r.region && <> · <strong>region:</strong> {r.region}</>}
              </Text>
              {r.description && <Text size="sm">{r.description}</Text>}
              {r.message && (
                <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                  &ldquo;{r.message}&rdquo;
                </Text>
              )}
              {r.status === 'denied' && r.deny_reason && (
                <Text size="xs" c="red">Denied: {r.deny_reason}</Text>
              )}
              {r.status === 'approved' && (
                <Text size="xs" c="dimmed">
                  Approved {fmt(r.reviewed_at)} by {r.reviewer_display_name ?? 'admin'}
                  {r.token_revealed ? ' · token revealed' : ' · token issued, not yet revealed'}
                </Text>
              )}
            </Stack>
          </Paper>
        ))}
      </Stack>
    </Paper>
  )
}
