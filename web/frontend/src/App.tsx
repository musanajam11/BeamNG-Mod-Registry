import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes, Link, useLocation } from 'react-router-dom'
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
import { BackendsPage } from './pages/BackendsPage'
import { MyBackendsPage } from './pages/MyBackendsPage'
import { DiscordLink } from './components/DiscordLink'
import { JoinPage } from './pages/JoinPage'
import { ProfilePage } from './pages/ProfilePage'
import { FaqPage } from './pages/FaqPage'
import { SubmitDraftProvider } from './state/SubmitDraftContext'
import { useApplyTheme } from './state/theme'
import { usePersonalTheme } from './state/personalTheme'

export function App() {
  const qc = useQueryClient()
  const [opened, { toggle }] = useDisclosure()
  const location = useLocation()
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/auth/me'),
  })
  const theme = useApplyTheme()
  const personal = usePersonalTheme()

  // Toggle the body background depending on whether the admin opted to
  // restrict it to the auth pages only. A user with a personal background
  // override always sees their wallpaper, regardless of the admin setting.
  // Anonymous viewers (no session) on the public /faq, /registry, and
  // /content-manager routes always get the same wallpaper as the login page
  // so the shell looks consistent before sign-in.
  useEffect(() => {
    const personalBg = !!personal.background_url
    const hasThemeBg = Boolean(theme && theme.background_url)
    const signedIn = Boolean(me.data?.user)
    const enable = hasThemeBg && (
      signedIn
        ? (personalBg || !theme?.apply_to_auth_only)
        : true
    )
    document.body.classList.toggle('app-bg-on', enable)
    return () => { document.body.classList.remove('app-bg-on') }
  }, [me.data?.user, theme, personal.background_url])

  if (me.isLoading) return null

  const user = me.data?.user ?? null
  const isJoinRoute = location.pathname.startsWith('/j/')

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
        <Route path="/faq" element={
          <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
            <Group justify="space-between" mb="md">
              <Link to="/login" style={{ display: 'inline-flex', alignItems: 'center' }}>
                <img
                  src="/app-icon.png"
                  alt={theme?.app_name ?? 'BeamNG Mod Registry'}
                  style={{ height: 40, width: 'auto', display: 'block' }}
                />
              </Link>
              <Button component={Link} to="/login" variant="subtle" size="xs">
                Back to sign in
              </Button>
            </Group>
            <FaqPage />
          </div>
        } />
        <Route path="/registry" element={
          <SubmitDraftProvider>
            <div style={{ maxWidth: 1300, margin: '0 auto', padding: 24 }}>
              <Group justify="space-between" mb="md">
                <Link to="/login" style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <img
                    src="/app-icon.png"
                    alt={theme?.app_name ?? 'BeamNG Mod Registry'}
                    style={{ height: 40, width: 'auto', display: 'block' }}
                  />
                </Link>
                <Group gap="xs">
                  <Button component={Link} to="/login" variant="subtle" size="xs">
                    Sign in
                  </Button>
                  <Button component={Link} to="/signup" variant="light" size="xs">
                    Sign up
                  </Button>
                </Group>
              </Group>
              <RegistryBrowserPage />
            </div>
          </SubmitDraftProvider>
        } />
        <Route path="/j/:code" element={<JoinPage />} />
        <Route
          path="/content-manager"
          element={
            <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
              <Group justify="space-between" mb="md">
                <Link to="/login" style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <img
                    src="/app-icon.png"
                    alt={theme?.app_name ?? 'BeamNG Mod Registry'}
                    style={{ height: 40, width: 'auto', display: 'block' }}
                  />
                </Link>
                <Button component={Link} to="/login" variant="subtle" size="xs">
                  Back to sign in
                </Button>
              </Group>
              <ContentManagerPage />
            </div>
          }
        />
        <Route
          path="/backends"
          element={
            <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
              <Group justify="space-between" mb="md">
                <Link to="/login" style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <img
                    src="/app-icon.png"
                    alt={theme?.app_name ?? 'BeamNG Mod Registry'}
                    style={{ height: 40, width: 'auto', display: 'block' }}
                  />
                </Link>
                <Button component={Link} to="/login" variant="subtle" size="xs">
                  Back to sign in
                </Button>
              </Group>
              <BackendsPage />
            </div>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  // Invite join links should always render as a shell-less public-style page,
  // even when the user is already authenticated.
  if (isJoinRoute) {
    return (
      <Routes>
        <Route path="/j/:code" element={<JoinPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    )
  }

  return (
    <SubmitDraftProvider>
    <AppShell
      header={{ height: 64 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <div style={{ position: 'relative', height: '100%' }}>
          <Group h="100%" px="md" justify="space-between" wrap="nowrap">
            <Group wrap="nowrap" gap="sm">
              <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
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
          <Link
            to="/"
            title={theme?.app_name ?? 'BeamNG Mod Registry'}
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              display: 'inline-flex',
              alignItems: 'center',
              textDecoration: 'none',
              pointerEvents: 'auto',
            }}
          >
            <img
              src="/wordmark.png"
              alt={theme?.app_name ?? 'BeamNG Mod Registry'}
              style={{ height: 50, width: 'auto', display: 'block' }}
            />
          </Link>
        </div>
      </AppShell.Header>
      <AppShell.Navbar p="md" style={{ display: 'flex', flexDirection: 'column' }}>
        <NavLink component={Link} to="/" label="Dashboard" />
        <NavLink component={Link} to="/registry" label="Registry browser" />
        <NavLink component={Link} to="/backends" label="BeamMP backends" />
        <NavLink component={Link} to="/submit/manual" label="Submit (manual)" />
        <NavLink component={Link} to="/faq" label="FAQ" />
        {(user.role === 'admin' || user.trust === 'green') && (
          <NavLink
            component={Link}
            to="/admin"
            label={user.role === 'admin' ? 'Admin' : 'Review queue'}
          />
        )}
        {user.role === 'admin' && <NavLink component={Link} to="/admin/settings" label="Settings" />}
        <NavLink component={Link} to="/profile" label="Profile" />
        <NavLink component={Link} to="/my/backends" label="My backends" />
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'stretch' }}>
          <DiscordLink label="Join the Discord" fullWidth />
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
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Link to="/registry" style={{ display: 'inline-flex', textDecoration: 'none' }} title="Open registry browser">
              <Image
                src="/app-icon.png"
                alt={theme?.app_name ?? 'BeamNG Mod Registry'}
                h={120}
                w="auto"
                fit="contain"
                style={{ cursor: 'pointer' }}
              />
            </Link>
          </div>
        </div>
      </AppShell.Navbar>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/j/:code" element={<JoinPage />} />
          <Route path="/content-manager" element={<ContentManagerPage />} />
          <Route path="/registry" element={<RegistryBrowserPage />} />
          <Route path="/backends" element={<BackendsPage />} />
          <Route path="/submit/manual" element={<SubmitManualPage />} />
          <Route path="/faq" element={<FaqPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/my/backends" element={<MyBackendsPage />} />
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
