/**
 * Admin → Settings page. Lets an admin configure the GitHub App credentials
 * at runtime. Values are stored encrypted-at-rest in SQLite and override
 * the corresponding env vars without a container restart.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert, Badge, Button, Container, Divider, Group, Paper, Stack,
  Switch, Text, TextInput, Textarea, Title,
} from '@mantine/core'
import { api, ApiError } from '../api/client'

interface GithubSettings {
  configured: boolean
  app_id: string
  private_key_set: boolean
  installation_id: string
  repo_owner: string
  repo_name: string
  default_branch: string
  auto_merge: boolean
}

interface TestResult {
  ok?: boolean
  repo?: { full_name: string; default_branch: string; private: boolean }
  error?: string
  message?: string
}

export function AdminSettingsPage() {
  const qc = useQueryClient()
  const settings = useQuery({
    queryKey: ['admin', 'settings', 'github'],
    queryFn: () => api.get<GithubSettings>('/admin/settings/github'),
  })

  const [appId, setAppId] = useState('')
  const [installationId, setInstallationId] = useState('')
  const [repoOwner, setRepoOwner] = useState('')
  const [repoName, setRepoName] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [autoMerge, setAutoMerge] = useState(true)
  const [privateKey, setPrivateKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  // Hydrate form once settings load.
  useEffect(() => {
    if (!settings.data) return
    setAppId(settings.data.app_id)
    setInstallationId(settings.data.installation_id)
    setRepoOwner(settings.data.repo_owner)
    setRepoName(settings.data.repo_name)
    setDefaultBranch(settings.data.default_branch)
    setAutoMerge(settings.data.auto_merge)
  }, [settings.data])

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        app_id: appId,
        installation_id: installationId,
        repo_owner: repoOwner,
        repo_name: repoName,
        default_branch: defaultBranch,
        auto_merge: autoMerge,
      }
      if (clearKey) body.private_key = '__clear__'
      else if (privateKey.trim()) body.private_key = privateKey
      return api.post<{ ok: true; configured: boolean }>('/admin/settings/github', body)
    },
    onSuccess: () => {
      setPrivateKey('')
      setClearKey(false)
      qc.invalidateQueries({ queryKey: ['admin', 'settings', 'github'] })
    },
  })

  const test = useMutation({
    mutationFn: () => api.post<TestResult>('/admin/settings/github/test'),
    onSuccess: (r) => setTestResult(r),
    onError: (err) => {
      if (err instanceof ApiError) {
        const body = err.body as TestResult | null
        setTestResult({ error: body?.error ?? 'unknown', message: body?.message })
      } else {
        setTestResult({ error: 'unknown', message: String(err) })
      }
    },
  })

  if (settings.isLoading) return null

  const s = settings.data!

  return (
    <Container size={720}>
      <Group justify="space-between" mb="md">
        <Title order={2}>Settings</Title>
        <Badge color={s.configured ? 'green' : 'yellow'} size="lg">
          {s.configured ? 'GitHub configured' : 'GitHub not configured'}
        </Badge>
      </Group>

      <Paper withBorder p="lg" radius="md">
        <Stack>
          <Title order={4}>GitHub App</Title>
          <Text c="dimmed" size="sm">
            The bot opens pull requests against the registry repo using a GitHub App
            installation. Create an App with <strong>Contents: Read &amp; Write</strong> and{' '}
            <strong>Pull requests: Read &amp; Write</strong>, install it on your registry
            repo, then paste the credentials here. These values override the corresponding
            env vars and take effect immediately — no restart required.
          </Text>

          <form onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
            <Stack>
              <TextInput
                label="App ID" required value={appId}
                onChange={(e) => setAppId(e.currentTarget.value)}
                description="Numeric ID from the App's settings page"
              />
              <TextInput
                label="Installation ID" required value={installationId}
                onChange={(e) => setInstallationId(e.currentTarget.value)}
                description="Numeric ID from the App's installation URL after installing it on the repo"
              />
              <Group grow align="flex-start">
                <TextInput
                  label="Repository owner" required value={repoOwner}
                  onChange={(e) => setRepoOwner(e.currentTarget.value)}
                  description="GitHub user or organization"
                />
                <TextInput
                  label="Repository name" required value={repoName}
                  onChange={(e) => setRepoName(e.currentTarget.value)}
                />
              </Group>
              <TextInput
                label="Default branch" value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.currentTarget.value)}
                description="Base branch for opened pull requests (usually main)"
              />
              <Switch
                label="Enable auto-merge after CI passes"
                checked={autoMerge}
                onChange={(e) => setAutoMerge(e.currentTarget.checked)}
              />
              <Divider label="Private key" labelPosition="center" />
              <Text size="xs" c="dimmed">
                Paste the contents of the App's <code>.pem</code> file. Stored in the local
                SQLite database; never echoed back to the UI.{' '}
                {s.private_key_set
                  ? <Badge color="green" size="sm">A private key is currently saved</Badge>
                  : <Badge color="red" size="sm">No private key on file</Badge>}
              </Text>
              <Textarea
                placeholder={s.private_key_set
                  ? 'Leave blank to keep the existing key, or paste a new one to replace it'
                  : '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----'}
                autosize minRows={5} maxRows={14}
                value={privateKey}
                onChange={(e) => { setPrivateKey(e.currentTarget.value); if (e.currentTarget.value) setClearKey(false) }}
                disabled={clearKey}
                styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
              />
              {s.private_key_set && (
                <Switch
                  label="Clear stored private key on save (revert to env var, if any)"
                  checked={clearKey}
                  onChange={(e) => setClearKey(e.currentTarget.checked)}
                />
              )}

              {save.isError && (
                <Alert color="red">
                  {save.error instanceof ApiError ? JSON.stringify(save.error.body) : 'Save failed'}
                </Alert>
              )}
              {save.isSuccess && (
                <Alert color="green">
                  Saved. {save.data.configured ? 'GitHub is now configured.' : 'Configuration is still incomplete.'}
                </Alert>
              )}

              <Group>
                <Button type="submit" loading={save.isPending}>Save</Button>
                <Button
                  variant="light" color="blue"
                  loading={test.isPending}
                  disabled={!s.configured && !save.isSuccess}
                  onClick={() => test.mutate()}
                >
                  Test connection
                </Button>
              </Group>

              {testResult && (
                testResult.ok && testResult.repo
                  ? <Alert color="green">
                      Connected to <strong>{testResult.repo.full_name}</strong>{' '}
                      (default branch <code>{testResult.repo.default_branch}</code>
                      {testResult.repo.private ? ', private' : ', public'}).
                    </Alert>
                  : <Alert color="red">
                      Test failed: {testResult.error ?? 'unknown error'}
                      {testResult.message ? ` — ${testResult.message}` : ''}
                    </Alert>
              )}
            </Stack>
          </form>
        </Stack>
      </Paper>
    </Container>
  )
}
