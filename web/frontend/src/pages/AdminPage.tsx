import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Alert, Anchor, Avatar, Badge, Button, Drawer, Group, Paper, ScrollArea,
  SegmentedControl, Stack, Table, Tabs, Text, Textarea, Title,
} from '@mantine/core'
import { api, ApiError, type User } from '../api/client'
import { BackendTokenRequestsPanel, BackendTokensPanel } from '../components/AdminBackendsPanels'

interface AdminUser {
  id: number; email: string; display_name: string
  role: 'user' | 'admin'; trust: 'green' | 'yellow' | 'red'
  created_at: number; last_login_at: number | null
}

interface AdminSubmission {
  id: number; user_id: number; kind: string; identifier: string; version: string | null
  status: string; pr_url: string | null; error: string | null; created_at: number
}

interface AdminSubmissionDetail extends AdminSubmission {
  branch: string | null
  reviewer_id: number | null
  review_note: string | null
  decided_at: number | null
  payload: Record<string, unknown> | null
}

interface SubmissionDetailResponse {
  submission: AdminSubmissionDetail
  submitter: {
    id: number; email: string; display_name: string
    role: 'user' | 'admin'; trust: 'green' | 'yellow' | 'red'
    created_at: number
  } | null
}

export function AdminPage() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/auth/me'),
  })
  const isAdmin = me.data?.user?.role === 'admin'
  const myUserId = me.data?.user?.id ?? null
  return (
    <Stack>
      <Title order={2}>{isAdmin ? 'Admin' : 'Review queue'}</Title>
      <Tabs defaultValue="queue">
        <Tabs.List>
          <Tabs.Tab value="queue">Pending queue</Tabs.Tab>
          {isAdmin && <Tabs.Tab value="users">Users</Tabs.Tab>}
          {isAdmin && <Tabs.Tab value="backends">Backends</Tabs.Tab>}
          {isAdmin && <Tabs.Tab value="audit">Audit log</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="queue" pt="md">
          <PendingQueue selfUserId={myUserId} canReviewSelf={isAdmin} isAdmin={isAdmin} />
        </Tabs.Panel>
        {isAdmin && <Tabs.Panel value="users" pt="md"><UsersTab /></Tabs.Panel>}
        {isAdmin && (
          <Tabs.Panel value="backends" pt="md">
            <Stack>
              <BackendTokenRequestsPanel />
              <BackendTokensPanel />
            </Stack>
          </Tabs.Panel>
        )}
        {isAdmin && <Tabs.Panel value="audit" pt="md"><AuditTab /></Tabs.Panel>}
      </Tabs>
    </Stack>
  )
}

function PendingQueue({
  selfUserId,
  canReviewSelf,
  isAdmin,
}: {
  selfUserId: number | null
  canReviewSelf: boolean
  isAdmin: boolean
}) {
  const qc = useQueryClient()
  const [reviewing, setReviewing] = useState<number | null>(null)

  const subs = useQuery({
    queryKey: ['admin', 'submissions', 'pending_review'],
    queryFn: () => api.get<{ submissions: AdminSubmission[] }>('/admin/submissions?status=pending_review'),
    refetchInterval: 5000,
  })

  if (!subs.data) return null
  // Reviewers (non-admin) can't act on their own submissions; hide them
  // from the queue entirely so the list isn't full of greyed-out rows.
  const visible = canReviewSelf
    ? subs.data.submissions
    : subs.data.submissions.filter((s) => s.user_id !== selfUserId)
  if (visible.length === 0) return <Text c="dimmed">No pending submissions.</Text>

  const closeReview = () => setReviewing(null)
  const onDecided = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'submissions'] })
    closeReview()
  }

  return (
    <>
      <Table withTableBorder striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>ID</Table.Th>
            <Table.Th>User</Table.Th>
            <Table.Th>Identifier</Table.Th>
            <Table.Th>Version</Table.Th>
            <Table.Th>Kind</Table.Th>
            <Table.Th>Created</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {visible.map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td>{s.id}</Table.Td>
              <Table.Td>#{s.user_id}</Table.Td>
              <Table.Td><code>{s.identifier}</code></Table.Td>
              <Table.Td>{s.version ?? '—'}</Table.Td>
              <Table.Td>{s.kind}</Table.Td>
              <Table.Td>{new Date(s.created_at).toLocaleString()}</Table.Td>
              <Table.Td>
                <Button size="xs" variant="light" onClick={() => setReviewing(s.id)}>
                  Review
                </Button>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Drawer
        opened={reviewing !== null}
        onClose={closeReview}
        position="right"
        size="xl"
        title={reviewing !== null ? `Review submission #${reviewing}` : 'Review'}
        scrollAreaComponent={ScrollArea.Autosize}
      >
        {reviewing !== null && <ReviewPanel id={reviewing} onDecided={onDecided} isAdmin={isAdmin} />}
      </Drawer>
    </>
  )
}

function ReviewPanel({ id, onDecided, isAdmin }: { id: number; onDecided: () => void; isAdmin: boolean }) {
  const [note, setNote] = useState('')

  const detail = useQuery({
    queryKey: ['admin', 'submission', id],
    queryFn: () => api.get<SubmissionDetailResponse>(`/admin/submissions/${id}`),
  })

  const approve = useMutation({
    mutationFn: () => api.post(`/admin/submissions/${id}/approve`, note ? { note } : undefined),
    onSuccess: onDecided,
  })
  const reject = useMutation({
    mutationFn: () =>
      api.post(`/admin/submissions/${id}/reject`, { note: note || 'rejected via admin UI' }),
    onSuccess: onDecided,
  })
  const requestChanges = useMutation({
    mutationFn: () =>
      api.post(`/admin/submissions/${id}/request-changes`, { note }),
    onSuccess: onDecided,
  })

  if (detail.isLoading) return <Text c="dimmed">Loading…</Text>
  if (detail.isError || !detail.data) return <Alert color="red">Failed to load submission.</Alert>

  const { submission: s, submitter } = detail.data
  const payload = s.payload ?? {}
  const isChangesRequested = s.status === 'changes_requested'
  const noteRequired = !note.trim()
  const get = (k: string): string | undefined => {
    const v = (payload as Record<string, unknown>)[k]
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  const tags = Array.isArray(payload.tags) ? (payload.tags as unknown[]).map(String) : []
  const isDelete = s.kind === 'delete'
  const deleteReason = isDelete ? get('reason') : undefined
  const deleteRequestedBy = isDelete ? get('requested_by') : undefined
  const deleteByOwner = isDelete && payload.is_owner === true

  return (
    <Stack>
      <Group gap="xs" wrap="wrap">
        <Badge color={isChangesRequested ? 'orange' : 'yellow'} variant="light">
          {isChangesRequested ? 'changes requested (resubmitted)' : 'pending'}
        </Badge>
        <Badge variant="outline" color={isDelete ? 'red' : undefined}>{s.kind}</Badge>
        <Text size="xs" c="dimmed">created {new Date(s.created_at).toLocaleString()}</Text>
      </Group>

      {isDelete && (
        <Alert color="red" variant="filled" title="⚠ Permanent deletion request">
          <Stack gap={4}>
            <Text size="sm">
              Approving this submission will <strong>permanently remove</strong>{' '}
              <code>mods/{s.identifier}/</code> and any matching auto-update template via PR.
              This action is admin-only and cannot be undone after the PR merges.
            </Text>
            {deleteRequestedBy && (
              <Text size="sm">
                <strong>Requested by:</strong> {deleteRequestedBy}
                {deleteByOwner && ' (current owner)'}
              </Text>
            )}
            {deleteReason && (
              <Paper p="xs" radius="sm" bg="rgba(0,0,0,0.25)">
                <Text size="xs" c="gray.2" mb={2}><strong>Reason</strong></Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{deleteReason}</Text>
              </Paper>
            )}
            {!isAdmin && (
              <Text size="xs" fs="italic">
                You can leave a reviewer note or reject, but only an admin can approve a deletion.
              </Text>
            )}
          </Stack>
        </Alert>
      )}

      {isChangesRequested && s.review_note && (
        <Alert color="orange" title="Previous reviewer note">
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{s.review_note}</Text>
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
          {get('multiplayer_scope') && <Text size="sm"><strong>MP:</strong> {get('multiplayer_scope')}</Text>}
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

      {submitter && (
        <Paper withBorder p="sm" radius="sm">
          <Text size="xs" c="dimmed" mb={4}>Submitter</Text>
          <Group gap="xs">
            <Text size="sm">{submitter.display_name} &lt;{submitter.email}&gt;</Text>
            <Badge size="xs" color={TRUST_COLOR[submitter.trust]}>{submitter.trust}</Badge>
            {submitter.role === 'admin' && <Badge size="xs" color="violet">admin</Badge>}
            <Text size="xs" c="dimmed">
              joined {new Date(submitter.created_at).toLocaleDateString()}
            </Text>
          </Group>
        </Paper>
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

      <Textarea
        label="Reviewer note"
        description="Required for Reject and Request changes. Optional for Approve. Shown to the submitter."
        placeholder="Explain what's wrong or what needs to change…"
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
        autosize minRows={2} maxRows={6}
      />

      {(approve.isError || reject.isError || requestChanges.isError) && (
        <Alert color="red">
          {(approve.error ?? reject.error ?? requestChanges.error) instanceof ApiError
            ? JSON.stringify(((approve.error ?? reject.error ?? requestChanges.error) as ApiError).body)
            : 'Decision failed'}
        </Alert>
      )}

      <Group justify="flex-end">
        <Button
          color="red"
          variant="light"
          onClick={() => reject.mutate()}
          loading={reject.isPending}
          disabled={approve.isPending || requestChanges.isPending}
        >
          Reject
        </Button>
        <Button
          color="orange"
          variant="light"
          onClick={() => requestChanges.mutate()}
          loading={requestChanges.isPending}
          disabled={approve.isPending || reject.isPending || noteRequired}
          title={noteRequired ? 'A reviewer note is required to request changes' : undefined}
        >
          Request changes
        </Button>
        <Button
          color={isDelete ? 'red' : 'green'}
          onClick={() => {
            if (isDelete) {
              if (!window.confirm(
                `Permanently delete '${s.identifier}'? A PR will be opened that removes the mod folder and any auto-update template.`
              )) return
            }
            approve.mutate()
          }}
          loading={approve.isPending}
          disabled={reject.isPending || requestChanges.isPending || (isDelete && !isAdmin)}
          title={isDelete && !isAdmin ? 'Only admins can approve a deletion request' : undefined}
        >
          {isDelete ? 'Approve & DELETE permanently' : 'Approve & queue'}
        </Button>
      </Group>
    </Stack>
  )
}

const TRUST_COLOR: Record<string, string> = { green: 'green', yellow: 'yellow', red: 'red' }

function UsersTab() {
  const qc = useQueryClient()
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<{ users: AdminUser[] }>('/admin/users'),
  })
  const setTrust = useMutation({
    mutationFn: ({ id, trust }: { id: number; trust: string }) =>
      api.post(`/admin/users/${id}/trust`, { trust }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: number; role: string }) =>
      api.post(`/admin/users/${id}/role`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  })

  if (!users.data) return null
  return (
    <Table withTableBorder striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>ID</Table.Th>
          <Table.Th>Email</Table.Th>
          <Table.Th>Display name</Table.Th>
          <Table.Th>Trust</Table.Th>
          <Table.Th>Role</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {users.data.users.map((u) => (
          <Table.Tr key={u.id}>
            <Table.Td>{u.id}</Table.Td>
            <Table.Td>{u.email}</Table.Td>
            <Table.Td>{u.display_name}</Table.Td>
            <Table.Td>
              <SegmentedControl
                size="xs"
                value={u.trust}
                onChange={(v) => setTrust.mutate({ id: u.id, trust: v })}
                data={[
                  { label: 'red', value: 'red' },
                  { label: 'yellow', value: 'yellow' },
                  { label: 'green', value: 'green' },
                ]}
                color={TRUST_COLOR[u.trust]}
              />
            </Table.Td>
            <Table.Td>
              <Group gap="xs">
                <Badge color={u.role === 'admin' ? 'violet' : 'gray'}>{u.role}</Badge>
                <Button size="xs" variant="subtle"
                  onClick={() => setRole.mutate({ id: u.id, role: u.role === 'admin' ? 'user' : 'admin' })}>
                  {u.role === 'admin' ? 'Demote' : 'Promote'}
                </Button>
              </Group>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )
}

interface AuditEntry {
  id: number; actor_id: number | null; action: string;
  target: string | null; details_json: string | null; created_at: number
  actor_display_name: string | null
  actor_email: string | null
  actor_avatar_url: string | null
}

function AuditTab() {
  const audit = useQuery({
    queryKey: ['admin', 'audit'],
    queryFn: () => api.get<{ entries: AuditEntry[] }>('/admin/audit'),
  })
  if (!audit.data) return null
  return (
    <Table withTableBorder striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>When</Table.Th>
          <Table.Th>Actor</Table.Th>
          <Table.Th>Action</Table.Th>
          <Table.Th>Target</Table.Th>
          <Table.Th>Details</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {audit.data.entries.map((e) => (
          <Table.Tr key={e.id}>
            <Table.Td>{new Date(e.created_at).toLocaleString()}</Table.Td>
            <Table.Td>
              {e.actor_id === null ? (
                <Text size="sm" c="dimmed">—</Text>
              ) : (
                <Group gap="xs" wrap="nowrap">
                  <Avatar src={e.actor_avatar_url ?? undefined} size={24} radius="xl">
                    {(e.actor_display_name ?? '?').slice(0, 2).toUpperCase()}
                  </Avatar>
                  <Stack gap={0}>
                    <Text size="sm">{e.actor_display_name ?? `user #${e.actor_id}`}</Text>
                    <Text size="xs" c="dimmed">#{e.actor_id}</Text>
                  </Stack>
                </Group>
              )}
            </Table.Td>
            <Table.Td><code>{e.action}</code></Table.Td>
            <Table.Td><code>{e.target ?? ''}</code></Table.Td>
            <Table.Td><code style={{ fontSize: 11 }}>{e.details_json ?? ''}</code></Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  )
}
