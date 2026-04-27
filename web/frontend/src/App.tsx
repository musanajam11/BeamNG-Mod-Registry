import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes, Link } from 'react-router-dom'
import { AppShell, Avatar, Burger, Group, NavLink, Image, Button } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { api, type User } from './api/client'
import { TrustDot } from './components/TrustDot'
import { LoginPage } from './pages/LoginPage'
import { SignupPage } from './pages/SignupPage'
import { VerifyEmailPage } from './pages/VerifyEmailPage'
import { DashboardPage } from './pages/DashboardPage'
import { SubmitManualPage } from './pages/SubmitManualPage'
import { AdminPage } from './pages/AdminPage'
import { AdminSettingsPage } from './pages/AdminSettingsPage'
import { RegistryBrowserPage } from './pages/RegistryBrowserPage'
import { ContentManagerPage, CM_LOGO_URL } from './pages/ContentManagerPage'
import { ProfilePage } from './pages/ProfilePage'
import { SubmitDraftProvider } from './state/SubmitDraftContext'
import { useApplyTheme } from './state/theme'
import { usePersonalTheme } from './state/personalTheme'

export function App() {
  const qc = useQueryClient()
  const [opened, { toggle }] = useDisclosure()
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/auth/me'),
  })
  const theme = useApplyTheme()
  const personal = usePersonalTheme()

  // Toggle the body background depending on whether the admin opted to
  // restrict it to the auth pages only. A user with a personal background
  // override always sees their wallpaper, regardless of the admin setting.
  useEffect(() => {
    const personalBg = !!personal.background_url
    const enable =
      Boolean(me.data?.user) &&
      Boolean(theme && theme.background_url) &&
      (personalBg || !theme?.apply_to_auth_only)
    document.body.classList.toggle('app-bg-on', enable)
    return () => { document.body.classList.remove('app-bg-on') }
  }, [me.data?.user, theme, personal.background_url])

  if (me.isLoading) return null

  const user = me.data?.user ?? null

  const handleLogout = async () => {
    try {
      await api.post('/auth/logout')
    } catch (err) {
      // Even if the call fails (e.g. CSRF mismatch after server restart), we
      // still want to drop the local session so the user can re-auth.
      console.warn('logout request failed; clearing client state anyway', err)
    }
    // Full page reload is the most reliable way to wipe in-memory state,
    // refetch /auth/me with the cleared cookie, and land on /login.
    qc.clear()
    window.location.assign('/login')
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onSuccess={() => me.refetch()} />} />
        <Route path="/signup" element={<SignupPage onSuccess={() => me.refetch()} />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route
          path="/content-manager"
          element={
            <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
              <Group justify="space-between" mb="md">
                <strong style={{ fontSize: 18 }}>{theme?.app_name ?? 'BeamNG Mod Registry'}</strong>
                <Button component={Link} to="/login" variant="subtle" size="xs">
                  Back to sign in
                </Button>
              </Group>
              <ContentManagerPage />
            </div>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <SubmitDraftProvider>
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap" gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: 0.2 }}>
              {theme?.app_name ?? 'BeamNG Mod Registry'}
            </span>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <Group gap={6}>
              <Avatar
                src={user.avatar_url ?? undefined}
                size={28}
                radius="xl"
                component={Link}
                to="/profile"
                style={{ cursor: 'pointer' }}
              >
                {user.display_name.slice(0, 2).toUpperCase()}
              </Avatar>
              <TrustDot trust={user.trust} />
              <Link to="/profile" style={{ color: 'inherit', textDecoration: 'none' }}>
                {user.display_name}
              </Link>
            </Group>
            <Button size="xs" variant="subtle" onClick={handleLogout}>Log out</Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md" style={{ display: 'flex', flexDirection: 'column' }}>
        <NavLink component={Link} to="/" label="Dashboard" />
        <NavLink component={Link} to="/registry" label="Registry browser" />
        <NavLink component={Link} to="/submit/manual" label="Submit (manual)" />
        {(user.role === 'admin' || user.trust === 'green') && (
          <NavLink
            component={Link}
            to="/admin"
            label={user.role === 'admin' ? 'Admin' : 'Review queue'}
          />
        )}
        {user.role === 'admin' && <NavLink component={Link} to="/admin/settings" label="Settings" />}
        <NavLink component={Link} to="/profile" label="Profile" />
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'stretch' }}>
          <Button
            component={Link}
            to="/content-manager"
            variant="light"
            size="sm"
            leftSection={
              <img
                src={CM_LOGO_URL}
                alt=""
                width={18}
                height={18}
                style={{ borderRadius: 4, display: 'block' }}
              />
            }
            fullWidth
          >
            Content Manager
          </Button>
          <div style={{ display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
            <Image
              src="/logo.png"
              alt={theme?.app_name ?? 'BeamNG Mod Registry'}
              h={180}
              w="auto"
              fit="contain"
            />
          </div>
        </div>
      </AppShell.Navbar>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/content-manager" element={<ContentManagerPage />} />
          <Route path="/registry" element={<RegistryBrowserPage />} />
          <Route path="/submit/manual" element={<SubmitManualPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          {(user.role === 'admin' || user.trust === 'green') && (
            <Route path="/admin" element={<AdminPage />} />
          )}
          {user.role === 'admin' && <Route path="/admin/settings" element={<AdminSettingsPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
    </SubmitDraftProvider>
  )
}
