/**
 * Admin â†’ Settings page. Lets an admin configure the GitHub App credentials
 * at runtime. Values are stored encrypted-at-rest in SQLite and override
 * the corresponding env vars without a container restart.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert, Badge, Button, Container, Divider, Group, Paper, Slider, Stack,
  Switch, Select, Text, TextInput, Textarea, Title,
} from '@mantine/core'
import { api, ApiError } from '../api/client'
import { THEME_QUERY_KEY, type ThemeConfig } from '../state/theme'

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
            env vars and take effect immediately â€” no restart required.
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
                      {testResult.message ? ` â€” ${testResult.message}` : ''}
                    </Alert>
              )}
            </Stack>
          </form>
        </Stack>
      </Paper>

      <AppearancePanel />
      <TurnstilePanel />
    </Container>
  )
}

const PRIMARY_COLORS = [
  'blue', 'cyan', 'teal', 'green', 'lime', 'yellow', 'orange', 'red',
  'pink', 'grape', 'violet', 'indigo', 'gray', 'dark',
] as const

function AppearancePanel() {
  const qc = useQueryClient()
  const themeQ = useQuery({
    queryKey: ['admin', 'settings', 'theme'],
    queryFn: () => api.get<ThemeConfig>('/admin/settings/theme'),
  })

  const [appName, setAppName] = useState('')
  const [bgUrl, setBgUrl] = useState('')
  const [blurPx, setBlurPx] = useState(14)
  const [dimPct, setDimPct] = useState(45)
  const [primary, setPrimary] = useState<string>('blue')
  const [scheme, setScheme] = useState<'auto' | 'light' | 'dark'>('auto')
  const [authOnly, setAuthOnly] = useState(false)

  useEffect(() => {
    if (!themeQ.data) return
    setAppName(themeQ.data.app_name)
    setBgUrl(themeQ.data.background_url)
    setBlurPx(themeQ.data.background_blur_px)
    setDimPct(themeQ.data.background_dim_pct)
    setPrimary(themeQ.data.primary_color)
    setScheme(themeQ.data.color_scheme)
    setAuthOnly(themeQ.data.apply_to_auth_only)
  }, [themeQ.data])

  // Live preview: write the in-flight admin draft into the *theme query
  // cache* (not directly to :root). `useApplyTheme()` in <App/> re-merges
  // this draft with any per-user personal override and then writes the
  // resulting CSS variables â€” so the admin sees their preview, while a
  // user with a personal background still sees their own. Writing :root
  // directly here used to race with App.tsx's effect and overwrite the
  // user's personal background while this page was open.
  useEffect(() => {
    if (!themeQ.data) return
    const draft: ThemeConfig = {
      background_url: bgUrl,
      background_blur_px: blurPx,
      background_dim_pct: dimPct,
      primary_color: primary,
      color_scheme: scheme,
      app_name: appName,
      apply_to_auth_only: authOnly,
    }
    qc.setQueryData(THEME_QUERY_KEY, draft)
  }, [bgUrl, blurPx, dimPct, primary, scheme, appName, authOnly, themeQ.data, qc])

  // When the admin leaves the page (or before unmounting after save), refetch
  // the canonical theme so any unsaved preview tweaks revert globally.
  useEffect(() => {
    return () => {
      qc.invalidateQueries({ queryKey: THEME_QUERY_KEY })
    }
  }, [qc])

  const save = useMutation({
    mutationFn: () =>
      api.post<{ ok: true; theme: ThemeConfig }>('/admin/settings/theme', {
        app_name: appName,
        background_url: bgUrl,
        background_blur_px: blurPx,
        background_dim_pct: dimPct,
        primary_color: primary,
        color_scheme: scheme,
        apply_to_auth_only: authOnly,
      }),
    onSuccess: (res) => {
      qc.setQueryData(['admin', 'settings', 'theme'], res.theme)
      qc.setQueryData(THEME_QUERY_KEY, res.theme)
    },
  })

  if (themeQ.isLoading) return null

  return (
    <Paper withBorder p="lg" radius="md" mt="xl">
      <Stack>
        <Title order={4}>Appearance</Title>
        <Text c="dimmed" size="sm">
          Customize the look of the app for everyone. Changes are previewed live
          before saving and applied to all users on save.
        </Text>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <Stack>
            <TextInput
              label="App name"
              description="Shown in the header and browser tab"
              value={appName}
              onChange={(e) => setAppName(e.currentTarget.value)}
              maxLength={64}
            />

            <Divider label="Background" labelPosition="left" />
            <TextInput
              label="Background image URL"
              description="Direct https:// link to an image. Leave blank to disable."
              value={bgUrl}
              onChange={(e) => setBgUrl(e.currentTarget.value)}
              placeholder="https://example.com/wallpaper.jpg"
            />
            <Stack gap={4}>
              <Text size="sm" fw={500}>Blur ({blurPx}px)</Text>
              <Slider min={0} max={60} step={1} value={blurPx} onChange={setBlurPx} />
            </Stack>
            <Stack gap={4}>
              <Text size="sm" fw={500}>Dim ({dimPct}%)</Text>
              <Slider min={0} max={90} step={1} value={dimPct} onChange={setDimPct} />
            </Stack>
            <Switch
              label="Apply background to login/signup pages only"
              checked={authOnly}
              onChange={(e) => setAuthOnly(e.currentTarget.checked)}
            />

            <Divider label="Color" labelPosition="left" />
            <Group grow align="flex-start">
              <Select
                label="Primary color"
                data={PRIMARY_COLORS.map((c) => ({ value: c, label: c }))}
                value={primary}
                onChange={(v) => v && setPrimary(v)}
                allowDeselect={false}
              />
              <Select
                label="Color scheme"
                data={[
                  { value: 'auto', label: 'Auto (follow OS)' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                value={scheme}
                onChange={(v) => v && setScheme(v as 'auto' | 'light' | 'dark')}
                allowDeselect={false}
              />
            </Group>

            {save.isError && (
              <Alert color="red">
                {save.error instanceof ApiError
                  ? JSON.stringify(save.error.body)
                  : 'Save failed'}
              </Alert>
            )}
            {save.isSuccess && <Alert color="green">Theme updated.</Alert>}

            <Group>
              <Button type="submit" loading={save.isPending}>Save appearance</Button>
              <Button
                variant="subtle"
                onClick={() => {
                  if (!themeQ.data) return
                  setAppName(themeQ.data.app_name)
                  setBgUrl(themeQ.data.background_url)
                  setBlurPx(themeQ.data.background_blur_px)
                  setDimPct(themeQ.data.background_dim_pct)
                  setPrimary(themeQ.data.primary_color)
                  setScheme(themeQ.data.color_scheme)
                  setAuthOnly(themeQ.data.apply_to_auth_only)
                }}
              >
                Revert
              </Button>
            </Group>
          </Stack>
        </form>
      </Stack>
    </Paper>
  )
}

interface TurnstileSettings {
  configured: boolean
  site_key: string
  secret_key_set: boolean
}

function TurnstilePanel() {
  const qc = useQueryClient()
  const tQ = useQuery({
    queryKey: ['admin', 'settings', 'turnstile'],
    queryFn: () => api.get<TurnstileSettings>('/admin/settings/turnstile'),
  })

  const [siteKey, setSiteKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [clearSecret, setClearSecret] = useState(false)

  useEffect(() => {
    if (!tQ.data) return
    setSiteKey(tQ.data.site_key)
  }, [tQ.data])

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { site_key: siteKey }
      if (clearSecret) body.secret_key = '__clear__'
      else if (secretKey.trim()) body.secret_key = secretKey
      return api.post<{ ok: true; configured: boolean }>('/admin/settings/turnstile', body)
    },
    onSuccess: () => {
      setSecretKey('')
      setClearSecret(false)
      qc.invalidateQueries({ queryKey: ['admin', 'settings', 'turnstile'] })
    },
  })

  if (tQ.isLoading) return null
  const t = tQ.data!

  return (
    <Paper withBorder p="lg" radius="md" mt="xl">
      <Stack>
        <Group justify="space-between">
          <Title order={4}>Cloudflare Turnstile</Title>
          <Badge color={t.configured ? 'green' : 'yellow'}>
            {t.configured ? 'Enabled' : 'Disabled'}
          </Badge>
        </Group>
        <Text c="dimmed" size="sm">
          Adds a Cloudflare Turnstile challenge to the login and signup forms to
          deter bots. Create a widget at{' '}
          <a href="https://dash.cloudflare.com/?to=/:account/turnstile" target="_blank" rel="noreferrer">
            dash.cloudflare.com â†’ Turnstile
          </a>
          {' '}for this site's hostname, then paste the site key and secret key here.
          When either field is blank the challenge is skipped entirely.
        </Text>

        <form onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          <Stack>
            <TextInput
              label="Site key"
              description="Public key embedded in the login/signup pages (starts with 0x4AAAâ€¦)"
              value={siteKey}
              onChange={(e) => setSiteKey(e.currentTarget.value)}
              placeholder="0x4AAAAAAA..."
            />
            <Divider label="Secret key" labelPosition="center" />
            <Text size="xs" c="dimmed">
              Used server-side to validate challenge responses. Stored in the local
              SQLite database; never echoed back to the UI.{' '}
              {t.secret_key_set
                ? <Badge color="green" size="sm">Secret key on file</Badge>
                : <Badge color="red" size="sm">No secret key on file</Badge>}
            </Text>
            <TextInput
              type="password"
              autoComplete="off"
              placeholder={t.secret_key_set
                ? 'Leave blank to keep the existing secret, or paste a new one to replace it'
                : '0x4AAAAAAA...'}
              value={secretKey}
              onChange={(e) => { setSecretKey(e.currentTarget.value); if (e.currentTarget.value) setClearSecret(false) }}
              disabled={clearSecret}
            />
            {t.secret_key_set && (
              <Switch
                label="Clear stored secret key on save (revert to env var, if any)"
                checked={clearSecret}
                onChange={(e) => setClearSecret(e.currentTarget.checked)}
              />
            )}

            {save.isError && (
              <Alert color="red">
                {save.error instanceof ApiError ? JSON.stringify(save.error.body) : 'Save failed'}
              </Alert>
            )}
            {save.isSuccess && (
              <Alert color="green">
                Saved. {save.data.configured
                  ? 'Turnstile is now enabled â€” reload the login page to see the widget.'
                  : 'Turnstile is still disabled (site key or secret key missing).'}
              </Alert>
            )}

            <Group>
              <Button type="submit" loading={save.isPending}>Save</Button>
            </Group>
          </Stack>
        </form>
      </Stack>
    </Paper>
  )
}
