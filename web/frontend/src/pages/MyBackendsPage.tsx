/**
 * "My backends" — signed-in users request a backend operator token here and,
 * once an admin approves the request, can reveal the plaintext at any
 * time. The plaintext stays in the DB so a refresh, a new device, or a
 * lost copy isn't a permanent loss — use "Revoke" from the admin panel
 * if a token leaks.
 */
import { useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api } from '../api/client'
import { Seo } from '../components/Seo'

interface BackendTokenRequest {
  id: number
  label: string
  url: string
  region: string
  description: string
  message: string
  status: 'pending' | 'approved' | 'denied'
  deny_reason: string
  requested_at: number
  reviewed_at: number | null
  token_available: boolean
  token_revealed: boolean
  token_revoked: boolean
  token_revoked_at: number | null
}

const URL_RE = /^https?:\/\/[A-Za-z0-9.\-]+(?::\d+)?(?:\/[\w\-./%]*)?$/

export function MyBackendsPage() {
  const qc = useQueryClient()
  const requests = useQuery({
    queryKey: ['my', 'backend-token-requests'],
    queryFn: () => api.get<{ requests: BackendTokenRequest[] }>('/backends/requests/me'),
  })

  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [region, setRegion] = useState('')
  const [description, setDescription] = useState('')
  const [message, setMessage] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: number }>('/backends/requests', {
        label: label.trim(),
        url: url.trim(),
        region: region.trim() || undefined,
        description: description.trim() || undefined,
        message: message.trim() || undefined,
      }),
    onSuccess: () => {
      setLabel('')
      setUrl('')
      setRegion('')
      setDescription('')
      setMessage('')
      qc.invalidateQueries({ queryKey: ['my', 'backend-token-requests'] })
    },
  })

  const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : '—')
  const rows = requests.data?.requests ?? []

  const urlValid = !url || URL_RE.test(url.trim())
  const canSubmit = label.trim().length > 0 && url.trim().length > 0 && urlValid

  return (
    <Container size="md" py="lg">
      <Seo
        title="My backends — request a publish key"
        description="Request a key to publish your decentralized BeamMP backend to the public BMR directory."
        canonicalPath="/my/backends"
      />
      <Stack>
        <Title order={2}>My backends</Title>
        <Text c="dimmed" size="sm">
          Request an operator key for a decentralized BeamMP backend (e.g. a{' '}
          <code>Decentralized-BMP-V2</code> instance). Once an admin approves
          your request, you can reveal the key here whenever you need it and
          paste it into your backend's <code>BMR_API_KEY</code> environment
          variable.
        </Text>

        <Paper withBorder p="lg" radius="md">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (canSubmit) create.mutate()
            }}
          >
            <Stack>
              <Title order={4}>Request a new key</Title>
              <TextInput
                label="Label"
                description="Friendly name for this backend (only you and admins see it)."
                placeholder="e.g. musa-vps-fra"
                value={label}
                onChange={(e) => setLabel(e.currentTarget.value)}
                required
                maxLength={80}
              />
              <TextInput
                label="Public URL"
                description="The HTTPS URL where your backend is reachable (e.g. https://beammp.example.com)."
                placeholder="https://beammp.example.com"
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
                required
                maxLength={256}
                error={!urlValid ? 'Must be a valid http(s) URL' : null}
              />
              <TextInput
                label="Region"
                description="Optional. Helps users pick a low-latency backend (e.g. EU-Frankfurt)."
                placeholder="EU-Frankfurt"
                value={region}
                onChange={(e) => setRegion(e.currentTarget.value)}
                maxLength={64}
              />
              <Textarea
                label="Description"
                description="Optional. What's this backend for? Who runs it?"
                placeholder="Public community backend, no allowlist."
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                maxLength={512}
                autosize
                minRows={2}
              />
              <Textarea
                label="Message to admins"
                description="Optional. Anything reviewers should know."
                value={message}
                onChange={(e) => setMessage(e.currentTarget.value)}
                maxLength={1000}
                autosize
                minRows={2}
              />
              <Group justify="flex-end">
                <Button type="submit" loading={create.isPending} disabled={!canSubmit}>
                  Request key
                </Button>
              </Group>
              {create.isError && (
                <Alert color="red">
                  {create.error instanceof ApiError
                    ? create.error.body && typeof create.error.body === 'object' && 'error' in create.error.body
                      ? describeError(String((create.error.body as { error: string }).error))
                      : 'Request failed.'
                    : 'Request failed.'}
                </Alert>
              )}
              {create.isSuccess && <Alert color="green">Request submitted. An admin will review it shortly.</Alert>}
            </Stack>
          </form>
        </Paper>

        <Title order={4}>Your requests</Title>
        {requests.isLoading && <Text c="dimmed" size="sm">Loading…</Text>}
        {requests.isError && <Alert color="red">Failed to load your requests.</Alert>}
        {requests.data && rows.length === 0 && (
          <Text c="dimmed" size="sm">You haven't requested any keys yet.</Text>
        )}
        {rows.map((r) => (
          <RequestRow
            key={r.id}
            row={r}
            onRevealed={() => qc.invalidateQueries({ queryKey: ['my', 'backend-token-requests'] })}
          />
        ))}
      </Stack>
    </Container>
  )
}

function describeError(code: string): string {
  switch (code) {
    case 'too_many_pending':
      return 'You already have several pending requests. Wait for an admin to review them first.'
    case 'duplicate_url':
      return 'That URL is already registered as a live backend. Pick a different URL or contact an admin.'
    case 'invalid_body':
      return 'Some fields are invalid. Check the form and try again.'
    default:
      return code
  }
}

function RequestRow({
  row,
  onRevealed,
}: {
  row: BackendTokenRequest
  onRevealed: () => void
}) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const reveal = useMutation({
    mutationFn: () => api.post<{ token: string; label: string }>(`/backends/requests/${row.id}/reveal`),
    onSuccess: (data) => {
      setRevealed(data.token)
      onRevealed()
    },
  })
  const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : '—')
  const statusColor = row.token_revoked
    ? 'gray'
    : row.status === 'pending'
      ? 'yellow'
      : row.status === 'approved'
        ? 'green'
        : 'red'
  const statusLabel = row.token_revoked ? 'revoked' : row.status

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            <Group gap="xs">
              <Text fw={600}>{row.label}</Text>
              <Badge size="sm" color={statusColor}>{statusLabel}</Badge>
              {row.token_revoked && row.status === 'approved' && (
                <Badge size="sm" color="gray" variant="outline">approved</Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">requested {fmt(row.requested_at)}</Text>
          </Stack>
          {row.token_available && !revealed && (
            <Button size="xs" color="green" onClick={() => reveal.mutate()} loading={reveal.isPending}>
              {row.token_revealed ? 'Show token again' : 'Reveal token'}
            </Button>
          )}
        </Group>
        <Text size="sm">
          <strong>URL:</strong> <code>{row.url}</code>
          {row.region && <> · <strong>region:</strong> {row.region}</>}
        </Text>
        {row.description && <Text size="sm">{row.description}</Text>}

        {row.token_revoked && (
          <Alert color="red" variant="light">
            This token was revoked by an admin{row.token_revoked_at ? ` on ${fmt(row.token_revoked_at)}` : ''}.
            Heartbeats from this backend will be rejected. Submit a new request
            below if you need a replacement key.
          </Alert>
        )}

        {row.status === 'denied' && (
          <Alert color="red" variant="light">
            Denied {fmt(row.reviewed_at)}{row.deny_reason ? ` — ${row.deny_reason}` : ''}.
          </Alert>
        )}

        {row.status === 'approved' && !row.token_revoked && row.token_revealed && !revealed && (
          <Text size="xs" c="dimmed">
            Token previously revealed. Click “Show token again” to display it once more.
          </Text>
        )}

        {revealed && (
          <Alert color="green" title={`Your token (${row.label})`} withCloseButton onClose={() => setRevealed(null)}>
            <Stack gap="xs">
              <Text size="sm">
                Paste this into your backend's <code>BMR_API_KEY</code>
                environment variable. You can come back and reveal it again
                if you lose it; if it leaks, ask an admin to revoke it.
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
                {revealed}
              </code>
              <Group>
                <Button size="xs" variant="light" onClick={() => navigator.clipboard?.writeText(revealed)}>
                  Copy
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}

        {reveal.isError && (
          <Alert color="red">Could not reveal token. It may have already been used.</Alert>
        )}
      </Stack>
    </Paper>
  )
}
