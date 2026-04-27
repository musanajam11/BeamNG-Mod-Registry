/**
 * Manual .beammod submission form.
 * Full-schema sectioned form with auto-detect from URL or zip upload.
 *
 * Form state is held in `SubmitDraftProvider` (mounted at the AppShell
 * level) so navigating to another tab and back preserves what the user
 * has already typed. The draft is also mirrored into sessionStorage so
 * an accidental refresh doesn't wipe it.
 */
import { useState } from 'react'
import {
  Accordion, Alert, Badge, Button, Container, Divider, FileButton, Group,
  Paper, Progress, Stack, Text, TextInput, Title,
} from '@mantine/core'
import { useMutation } from '@tanstack/react-query'
import { api, ApiError, type Submission } from '../api/client'
import { buildPayload, type FormState } from './submit/formState'
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
    mutationFn: () => api.post<InspectResult>('/submissions/inspect-url', { url: autoUrl }),
    onSuccess: (r) => {
      setAutoError(null)
      if (!f.download) update('download', autoUrl)
      applySuggestions(r)
    },
    onError: (err) => setAutoError(err instanceof ApiError ? JSON.stringify(err.body) : 'inspect failed'),
  })

  const inspectUpload = useMutation({
    mutationFn: (file: File) =>
      api.upload<InspectResult>('/submissions/inspect-upload', file, (loaded, total) => {
        setUploadProgress(Math.round((loaded / total) * 100))
      }),
    onMutate: () => setUploadProgress(0),
    onSettled: () => setUploadProgress(null),
    onSuccess: (r) => { setAutoError(null); applySuggestions(r) },
    onError: (err) => setAutoError(err instanceof ApiError ? JSON.stringify(err.body) : 'upload failed'),
  })

  const submitMut = useMutation({
    mutationFn: () => {
      const body = {
        identifier: f.identifier,
        version: f.version,
        payload: buildPayload(f),
        hash_server_side: hashServerSide,
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
          {uploadProgress !== null && <Progress value={uploadProgress} striped animated />}
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
            <AdvancedSection f={f} update={update} />
          </Accordion>
          <Divider />
          <Stack p="md">
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
            <Button type="submit" loading={submitMut.isPending} size="md">Submit</Button>
          </Stack>
        </form>
      </Paper>
    </Container>
  )
}
