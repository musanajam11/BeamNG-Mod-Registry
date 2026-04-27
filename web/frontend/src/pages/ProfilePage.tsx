import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Alert, Avatar, Button, ColorSwatch, FileButton, Group, Paper, PasswordInput,
  Slider, Stack, Text, TextInput, Title, Tooltip, UnstyledButton,
} from '@mantine/core'
import { api, type User } from '../api/client'
import { useTheme } from '../state/theme'
import {
  resetPersonalTheme, setPersonalTheme, usePersonalTheme,
} from '../state/personalTheme'

const MAX_AVATAR_BYTES = 512 * 1024 // raw image, before base64

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function ProfilePage() {
  const qc = useQueryClient()
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/auth/me'),
  })
  const user = me.data?.user

  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMsg, setProfileMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const resetRef = useRef<() => void>(null)

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name)
      setAvatarUrl(user.avatar_url)
    }
  }, [user])

  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [savingPw, setSavingPw] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  if (!user) return null

  const handleAvatarPick = async (file: File | null) => {
    setProfileMsg(null)
    if (!file) return
    if (file.size > MAX_AVATAR_BYTES) {
      setProfileMsg({ type: 'err', text: `Image too large — max ${Math.round(MAX_AVATAR_BYTES / 1024)} KB.` })
      resetRef.current?.()
      return
    }
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
      setProfileMsg({ type: 'err', text: 'Only PNG, JPEG, WebP, or GIF allowed.' })
      resetRef.current?.()
      return
    }
    try {
      const dataUrl = await fileToDataUrl(file)
      setAvatarUrl(dataUrl)
    } catch {
      setProfileMsg({ type: 'err', text: 'Failed to read image file.' })
    }
  }

  const saveProfile = async () => {
    setSavingProfile(true)
    setProfileMsg(null)
    try {
      const body: Record<string, unknown> = {}
      if (displayName !== user.display_name) body.display_name = displayName
      if (avatarUrl !== user.avatar_url) body.avatar_url = avatarUrl ?? ''
      if (Object.keys(body).length === 0) {
        setProfileMsg({ type: 'ok', text: 'Nothing to save.' })
        return
      }
      await api.patch('/auth/profile', body)
      await qc.invalidateQueries({ queryKey: ['me'] })
      await qc.invalidateQueries({ queryKey: ['auth', 'me'] })
      setProfileMsg({ type: 'ok', text: 'Profile saved.' })
    } catch (err) {
      setProfileMsg({ type: 'err', text: err instanceof Error ? err.message : 'Save failed.' })
    } finally {
      setSavingProfile(false)
    }
  }

  const changePassword = async () => {
    setPwMsg(null)
    if (newPw.length < 12) {
      setPwMsg({ type: 'err', text: 'New password must be at least 12 characters.' })
      return
    }
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'err', text: "New password and confirmation don't match." })
      return
    }
    setSavingPw(true)
    try {
      await api.post('/auth/change-password', {
        current_password: currentPw,
        new_password: newPw,
      })
      setPwMsg({ type: 'ok', text: 'Password updated.' })
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
    } catch (err) {
      setPwMsg({ type: 'err', text: err instanceof Error ? err.message : 'Change failed.' })
    } finally {
      setSavingPw(false)
    }
  }

  return (
    <Stack gap="lg">
      <Title order={2}>Your profile</Title>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">Display name &amp; portrait</Title>
        <Group align="flex-start" gap="lg" wrap="wrap">
          <Stack gap="xs" align="center">
            <Avatar src={avatarUrl ?? undefined} size={96} radius="xl">
              {user.display_name.slice(0, 2).toUpperCase()}
            </Avatar>
            <Group gap="xs">
              <FileButton
                resetRef={resetRef}
                onChange={handleAvatarPick}
                accept="image/png,image/jpeg,image/webp,image/gif"
              >
                {(props) => <Button {...props} size="xs" variant="light">Choose image</Button>}
              </FileButton>
              {avatarUrl && (
                <Button size="xs" variant="subtle" color="red" onClick={() => setAvatarUrl(null)}>
                  Remove
                </Button>
              )}
            </Group>
            <Text size="xs" c="dimmed">Max {Math.round(MAX_AVATAR_BYTES / 1024)} KB · PNG / JPEG / WebP / GIF</Text>
          </Stack>
          <Stack gap="sm" style={{ flex: 1, minWidth: 240 }}>
            <TextInput
              label="Display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
              maxLength={64}
              description="2–64 characters. Letters, numbers, spaces, and . _ - allowed."
            />
            <TextInput label="Email" value={user.email} disabled />
            {profileMsg && (
              <Alert color={profileMsg.type === 'ok' ? 'green' : 'red'}>{profileMsg.text}</Alert>
            )}
            <Group justify="flex-end">
              <Button onClick={saveProfile} loading={savingProfile}>Save changes</Button>
            </Group>
          </Stack>
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">Change password</Title>
        <Stack gap="sm" maw={420}>
          <PasswordInput
            label="Current password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.currentTarget.value)}
            autoComplete="current-password"
          />
          <PasswordInput
            label="New password"
            value={newPw}
            onChange={(e) => setNewPw(e.currentTarget.value)}
            autoComplete="new-password"
            description="Minimum 12 characters."
          />
          <PasswordInput
            label="Confirm new password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.currentTarget.value)}
            autoComplete="new-password"
          />
          {pwMsg && <Alert color={pwMsg.type === 'ok' ? 'green' : 'red'}>{pwMsg.text}</Alert>}
          <Group justify="flex-end">
            <Button
              onClick={changePassword}
              loading={savingPw}
              disabled={!currentPw || !newPw || !confirmPw}
            >
              Update password
            </Button>
          </Group>
        </Stack>
      </Paper>

      <PersonalAppearanceCard />
    </Stack>
  )
}

// ── Personal appearance ───────────────────────────────────────────────
// Per-browser overrides for the admin theme. Stored in localStorage and
// applied live; clearing a field falls back to the admin default.

const PRIMARY_COLOR_OPTIONS: { name: string; hex: string }[] = [
  { name: 'blue', hex: '#228be6' },
  { name: 'cyan', hex: '#15aabf' },
  { name: 'teal', hex: '#12b886' },
  { name: 'green', hex: '#40c057' },
  { name: 'lime', hex: '#82c91e' },
  { name: 'yellow', hex: '#fab005' },
  { name: 'orange', hex: '#fd7e14' },
  { name: 'red', hex: '#fa5252' },
  { name: 'pink', hex: '#e64980' },
  { name: 'grape', hex: '#be4bdb' },
  { name: 'violet', hex: '#7950f2' },
  { name: 'indigo', hex: '#4c6ef5' },
  { name: 'gray', hex: '#868e96' },
]

function PersonalAppearanceCard() {
  const admin = useTheme()
  const personal = usePersonalTheme()

  const effective = {
    background_url: personal.background_url ?? admin.data?.background_url ?? '',
    background_blur_px: personal.background_blur_px ?? admin.data?.background_blur_px ?? 14,
    background_dim_pct: personal.background_dim_pct ?? admin.data?.background_dim_pct ?? 45,
    primary_color: personal.primary_color ?? admin.data?.primary_color ?? 'blue',
  }

  // Local-only edit state for the URL so typing doesn't fire a re-render
  // storm on every keystroke.
  const [bgUrlDraft, setBgUrlDraft] = useState<string>(personal.background_url ?? '')
  useEffect(() => {
    setBgUrlDraft(personal.background_url ?? '')
  }, [personal.background_url])

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <div>
          <Title order={4}>Personal appearance</Title>
          <Text size="xs" c="dimmed">
            Overrides the site theme for this browser only. Leave a field blank to use the admin default.
          </Text>
        </div>
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          onClick={resetPersonalTheme}
          disabled={
            personal.background_url === null &&
            personal.background_blur_px === null &&
            personal.background_dim_pct === null &&
            personal.primary_color === null
          }
        >
          Reset to admin defaults
        </Button>
      </Group>

      <Stack gap="md">
        <Stack gap={4}>
          <Text size="sm" fw={600}>Background image URL</Text>
          <Group gap="xs" wrap="nowrap">
            <TextInput
              value={bgUrlDraft}
              onChange={(e) => setBgUrlDraft(e.currentTarget.value)}
              placeholder={admin.data?.background_url ?? 'https://…'}
              style={{ flex: 1 }}
            />
            <Button
              size="sm"
              variant="light"
              onClick={() => setPersonalTheme({ background_url: bgUrlDraft.trim() || null })}
            >
              Apply
            </Button>
            <Button
              size="sm"
              variant="subtle"
              color="gray"
              onClick={() => setPersonalTheme({ background_url: null })}
              disabled={personal.background_url === null}
            >
              Clear
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            HTTPS direct image link. Currently using:{' '}
            <span style={{ wordBreak: 'break-all' }}>{effective.background_url || '(none)'}</span>
          </Text>
        </Stack>

        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="sm" fw={600}>Background blur</Text>
            <Text size="xs" c="dimmed">{effective.background_blur_px}px</Text>
          </Group>
          <Slider
            min={0}
            max={60}
            step={1}
            value={effective.background_blur_px}
            onChange={(v) => setPersonalTheme({ background_blur_px: v })}
            marks={[{ value: 0, label: '0' }, { value: 30, label: '30' }, { value: 60, label: '60' }]}
          />
          {personal.background_blur_px !== null && (
            <UnstyledButton onClick={() => setPersonalTheme({ background_blur_px: null })}>
              <Text size="xs" c="blue">Use admin default ({admin.data?.background_blur_px ?? 14}px)</Text>
            </UnstyledButton>
          )}
        </Stack>

        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="sm" fw={600}>Background dimness</Text>
            <Text size="xs" c="dimmed">{effective.background_dim_pct}%</Text>
          </Group>
          <Slider
            min={0}
            max={90}
            step={1}
            value={effective.background_dim_pct}
            onChange={(v) => setPersonalTheme({ background_dim_pct: v })}
            marks={[{ value: 0, label: '0%' }, { value: 45, label: '45%' }, { value: 90, label: '90%' }]}
          />
          {personal.background_dim_pct !== null && (
            <UnstyledButton onClick={() => setPersonalTheme({ background_dim_pct: null })}>
              <Text size="xs" c="blue">Use admin default ({admin.data?.background_dim_pct ?? 45}%)</Text>
            </UnstyledButton>
          )}
        </Stack>

        <Stack gap={4}>
          <Text size="sm" fw={600}>Primary color</Text>
          <Group gap={6} wrap="wrap">
            {PRIMARY_COLOR_OPTIONS.map((c) => (
              <Tooltip key={c.name} label={c.name} withArrow openDelay={300}>
                <UnstyledButton onClick={() => setPersonalTheme({ primary_color: c.name })}>
                  <ColorSwatch
                    color={c.hex}
                    size={28}
                    style={{
                      cursor: 'pointer',
                      outline:
                        effective.primary_color === c.name
                          ? '2px solid var(--mantine-color-text)'
                          : '2px solid transparent',
                      outlineOffset: 2,
                    }}
                  />
                </UnstyledButton>
              </Tooltip>
            ))}
          </Group>
          {personal.primary_color !== null && (
            <UnstyledButton onClick={() => setPersonalTheme({ primary_color: null })}>
              <Text size="xs" c="blue">
                Use admin default ({admin.data?.primary_color ?? 'blue'})
              </Text>
            </UnstyledButton>
          )}
        </Stack>
      </Stack>
    </Paper>
  )
}
