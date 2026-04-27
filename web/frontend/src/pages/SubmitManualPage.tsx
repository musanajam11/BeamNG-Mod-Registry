/**
 * Manual .beammod submission form.
 * Full-schema sectioned form with auto-detect from URL or zip upload.
 *
 * Form state is held in `SubmitDraftProvider` (mounted at the AppShell
 * level) so navigating to another tab and back preserves what the user
 * has already typed. The draft is also mirrored into sessionStorage so
 * an accidental refresh doesn't wipe it.
 */
import { useRef, useState } from 'react'
import {
  Accordion, Alert, Badge, Button, Container, Divider, FileButton, Group,
  Paper, Progress, Stack, Text, TextInput, Title,
} from '@mantine/core'
import { useMutation } from '@tanstack/react-query'
import { api, ApiError, type Submission } from '../api/client'
import { buildPayload, buildWatchFields, type FormState } from './submit/formState'
import { AutoUpdateSection } from './submit/AutoUpdateSection'
import { useSubmitDraft, type InspectResult } from '../state/SubmitDraftContext'
import { BasicsSection } from './submit/BasicsSection'
import { DownloadSection } from './submit/DownloadSection'
import { MultiplayerSection } from './submit/MultiplayerSection'
import { CompatSection } from './submit/CompatSection'
import { DescriptionSection } from './submit/DescriptionSection'
import { ResourcesSection } from './submit/ResourcesSection'
import { RelationshipsSection } from './submit/RelationshipsSection'
import { InstallSection } from './submit/InstallSection'
import { AdvancedSection } from './submit/AdvancedSection'

export function SubmitManualPage() {
  const draft = useSubmitDraft()
  const f = draft.form
  const update = draft.update
  const setF = draft.setForm
  const hashServerSide = draft.hashServerSide
  const setHashServerSide = draft.setHashServerSide
  const autoUrl = draft.autoUrl
  const setAutoUrl = draft.setAutoUrl
  const inspectInfo = draft.inspectInfo
  const setInspectInfo = draft.setInspectInfo

  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [autoError, setAutoError] = useState<string | null>(null)

  // Live backend phase from the SSE channel.
  type ServerPhase =
    | 'received' | 'hashing' | 'listing' | 'analyzing' | 'reading_metadata' | 'done' | 'error'
  const [serverPhase, setServerPhase] = useState<ServerPhase | null>(null)
  const [serverPercent, setServerPercent] = useState<number | null>(null)
  const [serverDetail, setServerDetail] = useState<string | null>(null)
  const [serverBps, setServerBps] = useState<number | null>(null)
  const [serverEta, setServerEta] = useState<number | null>(null)
  const sseRef = useRef<EventSource | null>(null)

  const closeProgressStream = () => {
    sseRef.current?.close()
    sseRef.current = null
  }

  const openProgressStream = (): string => {
    closeProgressStream()
    setServerPhase(null)
    setServerPercent(null)
    setServerDetail(null)
    setServerBps(null)
    setServerEta(null)
    const id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '')
    const es = new EventSource(`/api/submissions/inspect-progress/${id}`, { withCredentials: true })
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as {
          phase: ServerPhase; percent?: number; detail?: string
          bytes_per_sec?: number; eta_sec?: number
        }
        setServerPhase(data.phase)
        if (data.percent !== undefined) setServerPercent(data.percent)
        else if (data.phase !== 'hashing') setServerPercent(null)
        if (data.detail !== undefined) setServerDetail(data.detail)
        setServerBps(data.bytes_per_sec ?? null)
        setServerEta(data.eta_sec ?? null)
        if (data.phase === 'done' || data.phase === 'error') closeProgressStream()
      } catch { /* ignore malformed event */ }
    }
    es.onerror = () => { /* let server close drive teardown */ }
    sseRef.current = es
    return id
  }

  const applySuggestions = (r: InspectResult) => {
    setInspectInfo(r)
    setF((s: FormState) => {
      const next: FormState = { ...s }
      if (!next.name && r.suggestions.name) next.name = r.suggestions.name
      if (!next.author && r.suggestions.author) next.author = r.suggestions.author
      if (!next.description && r.suggestions.description) next.description = r.suggestions.description
      if (!next.abstract && r.suggestions.description) {
        next.abstract = r.suggestions.description.split('\n')[0]?.slice(0, 512) ?? next.abstract
      }
      if (r.suggestions.mod_type) next.mod_type = r.suggestions.mod_type
      if (r.suggestions.multiplayer_scope) next.multiplayer_scope = r.suggestions.multiplayer_scope
      next.download_size = r.size
      return next
    })
  }

  const inspectUrl = useMutation({
    mutationFn: () => {
      const inspect_id = openProgressStream()
      return api.post<InspectResult>('/submissions/inspect-url', { url: autoUrl, inspect_id })
    },
    onSuccess: (r) => {
      setAutoError(null)
      if (!f.download) update('download', autoUrl)
      applySuggestions(r)
    },
    onError: (err) => setAutoError(extractErrorMessage(err, 'inspect failed')),
    onSettled: () => closeProgressStream(),
  })

  const inspectUpload = useMutation({
    mutationFn: (file: File) => {
      const inspect_id = openProgressStream()
      // Chunked upload (~80 MiB per request) so we slip under Cloudflare's
      // 100 MiB per-request body cap. The server appends chunks to a single
      // temp file and runs the inspector on the final chunk.
      return api.uploadChunked<InspectResult>(
        '/submissions/inspect-upload-chunk',
        file,
        {
          onProgress: (loaded, total) =>
            setUploadProgress(Math.round((loaded / total) * 100)),
          query: { inspect_id },
        },
      )
    },
    onMutate: () => setUploadProgress(0),
    onSettled: () => { setUploadProgress(null); closeProgressStream() },
    onSuccess: (r) => { setAutoError(null); applySuggestions(r) },
    onError: (err) => setAutoError(extractErrorMessage(err, 'upload failed')),
  })

  const submitMut = useMutation({
    mutationFn: () => {
      const body = {
        identifier: f.identifier,
        version: f.version,
        payload: buildPayload(f),
        hash_server_side: hashServerSide,
        ...buildWatchFields(f),
      }
      const url = draft.resubmittingId
        ? `/submissions/mine/${draft.resubmittingId}/resubmit`
        : '/submissions/manual'
      return api.post<{ submission: Submission }>(url, body)
    },
    onSuccess: () => draft.reset(),
  })

  return (
    <Container size={840}>
      <Group justify="space-between" align="flex-end" mb="xs">
        <Title order={2}>Submit a mod</Title>
        <Button size="xs" variant="subtle" color="gray" onClick={draft.reset}>
          Clear draft
        </Button>
      </Group>
      <Text c="dimmed" mb="lg" size="sm">
        Paste a download URL <em>or</em> upload a zip and we'll auto-detect as much as
        possible. Everything is editable below before submission. Your draft is
        preserved when you switch tabs.
      </Text>

      {draft.resubmittingId && (
        <Alert color="orange" mb="md" title={`Revising submission #${draft.resubmittingId}`}>
          <Text size="sm">
            An admin asked you to revise this submission. Apply the requested changes
            and submit again — the existing review thread will be reused instead of
            opening a new one.
          </Text>
        </Alert>
      )}

      {draft.editingExisting && (
        <Alert color="blue" mb="md" title="Editing an existing entry">
          <Text size="sm">
            You loaded <code>{draft.editingExisting}</code> from the registry browser.
            Edits to existing entries always go through admin review so we can verify
            authorship. If you're publishing a new version, bump the <strong>version</strong>{' '}
            field below; otherwise the existing version file will be overwritten.
          </Text>
        </Alert>
      )}

      <Paper withBorder p="md" radius="md" mb="md">
        <Stack gap="sm">
          <Text fw={600} size="sm">Auto-detect</Text>
          <Group align="flex-end" gap="sm" wrap="nowrap">
            <TextInput
              style={{ flex: 1 }}
              label="From download URL"
              placeholder="https://example.com/my_mod-1.0.0.zip"
              value={autoUrl}
              onChange={(e) => setAutoUrl(e.currentTarget.value)}
            />
            <Button onClick={() => inspectUrl.mutate()} disabled={!autoUrl} loading={inspectUrl.isPending}>
              Inspect URL
            </Button>
          </Group>
          <Group gap="sm">
            <FileButton
              accept=".zip,application/zip"
              onChange={(file) => file && inspectUpload.mutate(file)}
              disabled={inspectUpload.isPending}
            >
              {(props) => (
                <Button {...props} variant="light" loading={inspectUpload.isPending}>
                  Upload zip to inspect
                </Button>
              )}
            </FileButton>
            <Text size="xs" c="dimmed">
              Up to 2 GiB. Server reads the zip's central directory and detects BeamNG metadata.
            </Text>
          </Group>
          {uploadProgress !== null && (
            <Stack gap={2}>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">Uploading…</Text>
                <Text size="xs" c="dimmed">{uploadProgress}%</Text>
              </Group>
              <Progress value={uploadProgress} striped animated />
            </Stack>
          )}
          {serverPhase && serverPhase !== 'done' && serverPhase !== 'error' && (
            <Stack gap={2}>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  {phaseLabel(serverPhase)}{serverDetail ? ` — ${serverDetail}` : ''}
                </Text>
                <Group gap="xs">
                  {serverBps !== null && serverPhase === 'hashing' && (
                    <Text size="xs" c="dimmed">{formatBytesPerSec(serverBps)}</Text>
                  )}
                  {serverEta !== null && serverPhase === 'hashing' && (
                    <Text size="xs" c="dimmed">ETA {formatEta(serverEta)}</Text>
                  )}
                  {serverPercent !== null && <Text size="xs" c="dimmed">{serverPercent}%</Text>}
                </Group>
              </Group>
              <Progress
                value={serverPercent ?? 100}
                striped animated
                color={serverPhase === 'hashing' ? 'blue' : 'cyan'}
              />
            </Stack>
          )}
          {autoError && <Alert color="red">{autoError}</Alert>}
          {inspectInfo && (
            <Alert color="green">
              <Stack gap={4}>
                <Group gap="xs">
                  <Badge color="green">SHA256 ✓</Badge>
                  <Text size="xs" style={{ wordBreak: 'break-all' }}>{inspectInfo.sha256}</Text>
                </Group>
                <Text size="xs">
                  Size: {(inspectInfo.size / 1_048_576).toFixed(2)} MiB · Files: {inspectInfo.file_count}
                  {inspectInfo.suggestions.has_resources_layout && ' · Resources/ layout detected'}
                </Text>
                {inspectInfo.warnings.length > 0 && (
                  <Text size="xs" c="orange">{inspectInfo.warnings.join(' · ')}</Text>
                )}
              </Stack>
            </Alert>
          )}
        </Stack>
      </Paper>

      <Paper withBorder radius="md">
        <form onSubmit={(e) => { e.preventDefault(); submitMut.mutate() }}>
          <Accordion multiple defaultValue={['basics']} variant="separated" radius={0}>
            <BasicsSection f={f} update={update} />
            <DownloadSection f={f} update={update} hashServerSide={hashServerSide} setHashServerSide={setHashServerSide} />
            <MultiplayerSection f={f} update={update} />
            <CompatSection f={f} update={update} />
            <DescriptionSection f={f} update={update} />
            <ResourcesSection f={f} update={update} />
            <RelationshipsSection f={f} update={update} />
            <InstallSection f={f} update={update} />
            <AutoUpdateSection f={f} update={update} />
            <AdvancedSection f={f} update={update} />
          </Accordion>
          <Divider />
          <Stack p="md">
            {(() => {
              // Inline validation: check required fields + (when editing
              // an existing entry) that something actually changed. Both
              // gates feed into a single Alert + disabled Submit button so
              // users get an obvious reason rather than a silent failure.
              const requiredFields: { key: keyof FormState; label: string }[] = [
                { key: 'identifier', label: 'Identifier' },
                { key: 'version', label: 'Version' },
                { key: 'name', label: 'Name' },
                { key: 'abstract', label: 'Abstract' },
                { key: 'author', label: 'Author' },
                { key: 'license', label: 'License' },
              ]
              const missing = requiredFields.filter(
                (rf) => String(f[rf.key] ?? '').trim().length === 0,
              )
              const isEditing = Boolean(draft.editingExisting || draft.resubmittingId)
              const noChanges =
                isEditing &&
                draft.originalSnapshot !== null &&
                draft.originalSnapshot === JSON.stringify(f)
              const blocked = missing.length > 0 || noChanges
              return (
                <>
                  {missing.length > 0 && (
                    <Alert color="yellow" title="Required fields missing">
                      Please fill in: {missing.map((m) => m.label).join(', ')}.
                    </Alert>
                  )}
                  {noChanges && missing.length === 0 && (
                    <Alert color="orange" title="No changes detected">
                      You haven't modified anything since loading this entry. Edit at
                      least one field before submitting.
                    </Alert>
                  )}
                  {submitMut.isError && (
                    <Alert color="red">
                      {submitMut.error instanceof ApiError
                        ? <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{JSON.stringify(submitMut.error.body, null, 2)}</pre>
                        : 'Submission failed'}
                    </Alert>
                  )}
                  {submitMut.isSuccess && (
                    <Alert color="green">
                      Submission #{submitMut.data.submission.id} created — status: <strong>{submitMut.data.submission.status}</strong>.
                      {submitMut.data.submission.status === 'pending_review' && ' An admin will review shortly.'}
                    </Alert>
                  )}
                  <Button type="submit" loading={submitMut.isPending} size="md" disabled={blocked}>
                    Submit
                  </Button>
                </>
              )
            })()}
          </Stack>
        </form>
      </Paper>
    </Container>
  )
}

function phaseLabel(p: string): string {
  switch (p) {
    case 'received': return 'Upload received'
    case 'hashing': return 'Computing SHA-256'
    case 'listing': return 'Reading zip directory'
    case 'analyzing': return 'Detecting BeamNG layout'
    case 'reading_metadata': return 'Parsing info.json'
    case 'done': return 'Done'
    case 'error': return 'Failed'
    default: return p
  }
}

function formatBytesPerSec(bps: number): string {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let v = bps
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

function formatEta(sec: number): string {
  if (sec < 1) return '<1s'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null
    if (body?.message) return body.message
    if (body?.error) return body.error
    return fallback
  }
  return fallback
}
