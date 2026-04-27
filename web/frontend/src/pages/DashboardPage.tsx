import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import {
  Alert, Anchor, Badge, Button, Divider, Drawer, Group, Loader, Paper,
  ScrollArea, Stack, Table, Text, Title,
} from '@mantine/core'
import { api, type Submission, type User } from '../api/client'
import { useSubmitDraft } from '../state/SubmitDraftContext'

interface AuthConfig {
  turnstile_site_key: string | null
  email_verification_required: boolean
}

interface NewsItem {
  id: string
  source: 'steam' | 'beammp'
  title: string
  url: string
  date: number
  summary: string
}

function timeAgo(epochSec: number): string {
  if (!epochSec) return ''
  const diff = Date.now() / 1000 - epochSec
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w ago`
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`
  return `${Math.floor(diff / (86400 * 365))}y ago`
}

function NewsFeed() {
  const news = useQuery({
    queryKey: ['news'],
    queryFn: () => api.get<{ items: NewsItem[]; cached: boolean }>('/news'),
    // Server caches for 30 min, so no point fetching more often.
    staleTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  })
  const items = (news.data?.items ?? []).slice(0, 6)
  if (news.isLoading || items.length === 0) return null
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="sm">
        <Text size="xs" c="dimmed">Latest from BeamNG · BeamMP</Text>
      </Group>
      <Stack gap="xs">
        {items.map((item) => (
          <Anchor
            key={item.id}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            underline="never"
            style={{ display: 'block', color: 'inherit' }}
          >
            <Paper withBorder p="xs" radius="sm">
              <Group gap="xs" mb={4} wrap="nowrap">
                <Badge size="xs" variant="light" color={item.source === 'beammp' ? 'blue' : 'teal'}>
                  {item.source === 'beammp' ? 'BeamMP' : 'BeamNG'}
                </Badge>
                <Text size="xs" c="dimmed">{timeAgo(item.date)}</Text>
              </Group>
              <Text size="sm" fw={600} lineClamp={1}>{item.title}</Text>
              {item.summary && (
                <Text size="xs" c="dimmed" lineClamp={2} mt={2}>
                  {item.summary}
                </Text>
              )}
            </Paper>
          </Anchor>
        ))}
      </Stack>
    </Paper>
  )
}

function EmailVerificationBanner() {
  const me = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.get<{ user: User | null }>('/auth/me'),
  })
  const cfg = useQuery({
    queryKey: ['auth', 'config'],
    queryFn: () => api.get<AuthConfig>('/auth/config'),
  })
  const resend = useMutation({
    mutationFn: () => api.post('/auth/resend-verification'),
  })
  const user = me.data?.user
  if (!user || user.email_verified) return null
  if (!cfg.data?.email_verification_required) return null
  return (
    <Alert color="yellow" title="Confirm your email">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm">
          We sent a verification link to <code>{user.email}</code>. You must confirm
          before submitting mods.
        </Text>
        <Button
          size="xs"
          variant="light"
          loading={resend.isPending}
          disabled={resend.isSuccess}
          onClick={() => resend.mutate()}
        >
          {resend.isSuccess ? 'Sent — check your inbox' : 'Resend email'}
        </Button>
      </Group>
    </Alert>
  )
}

const STATUS_COLOR: Record<string, string> = {
  pending_review: 'yellow',
  changes_requested: 'orange',
  queued: 'blue',
  processing: 'blue',
  pr_opened: 'cyan',
  merged: 'green',
  rejected: 'red',
  failed: 'red',
}

interface SubmissionDetail extends Submission {
  branch: string | null
  review_note: string | null
  payload: Record<string, unknown> | null
}

export function DashboardPage() {
  const [viewing, setViewing] = useState<number | null>(null)

  const subs = useQuery({
    queryKey: ['submissions', 'mine'],
    queryFn: () => api.get<{ submissions: Submission[] }>('/submissions/mine'),
    refetchInterval: 5000,
  })

  return (
    <Stack>
      <Title order={2}>Your submissions</Title>
      <EmailVerificationBanner />
      {subs.isLoading && <Loader />}
      {subs.data && subs.data.submissions.length === 0 && (
        <Text c="dimmed">
          You haven't submitted anything yet. Use the navbar to submit a mod.
        </Text>
      )}
      {subs.data && subs.data.submissions.length > 0 && (
        <Table withTableBorder striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>ID</Table.Th>
              <Table.Th>Identifier</Table.Th>
              <Table.Th>Version</Table.Th>
              <Table.Th>Kind</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>PR</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th></Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {subs.data.submissions.map((s) => (
              <Table.Tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => setViewing(s.id)}>
                <Table.Td>{s.id}</Table.Td>
                <Table.Td><code>{s.identifier}</code></Table.Td>
                <Table.Td>{s.version ?? '—'}</Table.Td>
                <Table.Td>{s.kind}</Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    <Badge color={STATUS_COLOR[s.status] ?? 'gray'}>{s.status}</Badge>
                    {s.error && <Text size="xs" c="red" lineClamp={1}>{s.error}</Text>}
                  </Group>
                </Table.Td>
                <Table.Td onClick={(e) => e.stopPropagation()}>
                  {s.pr_url ? <Anchor href={s.pr_url} target="_blank">view</Anchor> : '—'}
                </Table.Td>
                <Table.Td>{new Date(s.created_at).toLocaleString()}</Table.Td>
                <Table.Td>
                  <Button size="xs" variant="subtle">View</Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Divider my="md" />
      <Title order={2}>News</Title>
      <NewsFeed />

      <Drawer
        opened={viewing !== null}
        onClose={() => setViewing(null)}
        position="right"
        size="xl"
        title={viewing !== null ? `Submission #${viewing}` : 'Submission'}
        scrollAreaComponent={ScrollArea.Autosize}
      >
        {viewing !== null && (
          <SubmissionDetailView id={viewing} onClose={() => setViewing(null)} />
        )}
      </Drawer>
    </Stack>
  )
}

function SubmissionDetailView({ id, onClose }: { id: number; onClose: () => void }) {
  const draft = useSubmitDraft()
  const navigate = useNavigate()

  const detail = useQuery({
    queryKey: ['submission', 'mine', id],
    queryFn: () => api.get<{ submission: SubmissionDetail }>(`/submissions/mine/${id}`),
  })

  if (detail.isLoading) return <Text c="dimmed">Loading…</Text>
  if (detail.isError || !detail.data) return <Alert color="red">Failed to load submission.</Alert>

  const s = detail.data.submission
  const payload = (s.payload ?? {}) as Record<string, unknown>
  const get = (k: string): string | undefined => {
    const v = payload[k]
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  const tags = Array.isArray(payload.tags) ? (payload.tags as unknown[]).map(String) : []

  const reuseDraft = (resubmit: boolean) => {
    draft.loadFromExisting(payload, { bumpVersion: false })
    draft.setResubmittingId(resubmit ? s.id : null)
    onClose()
    navigate('/submit/manual')
  }

  return (
    <Stack>
      <Group gap="xs" wrap="wrap">
        <Badge color={STATUS_COLOR[s.status] ?? 'gray'}>{s.status}</Badge>
        <Badge variant="outline">{s.kind}</Badge>
        <Text size="xs" c="dimmed">created {new Date(s.created_at).toLocaleString()}</Text>
        {s.decided_at && (
          <Text size="xs" c="dimmed">decided {new Date(s.decided_at).toLocaleString()}</Text>
        )}
      </Group>

      {(s.status === 'rejected' || s.status === 'failed') && (s.review_note || s.error) && (
        <Alert color="red" title={s.status === 'rejected' ? 'Rejected by reviewer' : 'Pipeline failed'}>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {s.review_note ?? s.error}
          </Text>
        </Alert>
      )}

      {s.status === 'changes_requested' && (
        <Alert color="orange" title="Reviewer requested changes">
          {s.review_note && (
            <Text size="sm" mb="sm" style={{ whiteSpace: 'pre-wrap' }}>{s.review_note}</Text>
          )}
          <Text size="xs" c="dimmed" mb="sm">
            Apply the changes below and resubmit. Your update will go back to the
            same reviewer in the existing queue — no new submission row is created.
          </Text>
          <Button size="xs" color="orange" onClick={() => reuseDraft(true)}>
            Edit &amp; resubmit
          </Button>
        </Alert>
      )}

      {s.status === 'merged' && s.review_note && (
        <Alert color="green" title="Approved with note">
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{s.review_note}</Text>
        </Alert>
      )}

      {s.status === 'pending_review' && (
        <Alert color="yellow">
          Awaiting admin review. You can leave this open — the dashboard auto-refreshes.
        </Alert>
      )}

      {s.pr_url && (
        <Alert color="cyan">
          Pull request opened:{' '}
          <Anchor href={s.pr_url} target="_blank" rel="noopener noreferrer">{s.pr_url}</Anchor>
        </Alert>
      )}

      <Paper withBorder p="sm" radius="sm">
        <Stack gap={4}>
          <Text size="sm"><strong>Identifier:</strong> <code>{s.identifier}</code></Text>
          <Text size="sm"><strong>Version:</strong> {s.version ?? '—'}</Text>
          {get('name') && <Text size="sm"><strong>Name:</strong> {get('name')}</Text>}
          {get('author') && <Text size="sm"><strong>Author:</strong> {get('author')}</Text>}
          {get('license') && <Text size="sm"><strong>License:</strong> {get('license')}</Text>}
          {get('mod_type') && <Text size="sm"><strong>Type:</strong> {get('mod_type')}</Text>}
          {get('release_status') && <Text size="sm"><strong>Status:</strong> {get('release_status')}</Text>}
        </Stack>
      </Paper>

      {get('abstract') && (
        <Paper withBorder p="sm" radius="sm">
          <Text size="xs" c="dimmed" mb={4}>Abstract</Text>
          <Text size="sm">{get('abstract')}</Text>
        </Paper>
      )}

      {get('description') && (
        <Paper withBorder p="sm" radius="sm">
          <Text size="xs" c="dimmed" mb={4}>Description</Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{get('description')}</Text>
        </Paper>
      )}

      {(get('download') || get('thumbnail')) && (
        <Paper withBorder p="sm" radius="sm">
          {get('download') && (
            <Text size="xs">
              <strong>Download:</strong>{' '}
              <Anchor href={get('download')} target="_blank" rel="noopener noreferrer">
                {get('download')}
              </Anchor>
            </Text>
          )}
          {get('thumbnail') && (
            <Text size="xs">
              <strong>Thumbnail:</strong>{' '}
              <Anchor href={get('thumbnail')} target="_blank" rel="noopener noreferrer">
                {get('thumbnail')}
              </Anchor>
            </Text>
          )}
        </Paper>
      )}

      {tags.length > 0 && (
        <Group gap={4}>
          {tags.map((t) => <Badge key={t} size="xs" variant="dot">{t}</Badge>)}
        </Group>
      )}

      <details>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: '#94a3b8' }}>
          Raw payload
        </summary>
        <pre
          style={{
            background: '#0b1220', color: '#cbd5e1', padding: 12, borderRadius: 6,
            fontSize: 11, overflow: 'auto', maxHeight: 400, marginTop: 8,
          }}
        >
          {JSON.stringify(payload, null, 2)}
        </pre>
      </details>

      {(s.status === 'rejected' || s.status === 'failed') && (
        <Group justify="flex-end">
          <Button variant="light" onClick={() => reuseDraft(false)}>
            Edit &amp; resubmit
          </Button>
        </Group>
      )}
    </Stack>
  )
}
