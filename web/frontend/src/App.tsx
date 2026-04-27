import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, Route, Routes, Link } from 'react-router-dom'
import { AppShell, Burger, Group, NavLink, Image, Button } from '@mantine/core'
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
import { SubmitDraftProvider } from './state/SubmitDraftContext'
import { useApplyTheme } from './state/theme'

export function App() {
  const qc = useQueryClient()
  const [opened, { toggle }] = useDisclosure()
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User | null }>('/auth/me'),
  })
  const theme = useApplyTheme()

  // Toggle the body background depending on whether the admin opted to
  // restrict it to the auth pages only.
  useEffect(() => {
    const enable =
      Boolean(me.data?.user) &&
      Boolean(theme && !theme.apply_to_auth_only && theme.background_url)
    document.body.classList.toggle('app-bg-on', enable)
    return () => { document.body.classList.remove('app-bg-on') }
  }, [me.data?.user, theme])

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
              <TrustDot trust={user.trust} />
              <span>{user.display_name}</span>
            </Group>
            <Button size="xs" variant="subtle" onClick={handleLogout}>Log out</Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md" style={{ position: 'relative' }}>
        <NavLink component={Link} to="/" label="Dashboard" />
        <NavLink component={Link} to="/registry" label="Registry browser" />
        <NavLink component={Link} to="/submit/manual" label="Submit (manual)" />
        {user.role === 'admin' && <NavLink component={Link} to="/admin" label="Admin" />}
        {user.role === 'admin' && <NavLink component={Link} to="/admin/settings" label="Settings" />}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 12,
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Image
            src="/logo.png"
            alt={theme?.app_name ?? 'BeamNG Mod Registry'}
            h={180}
            w="auto"
            fit="contain"
          />
        </div>
      </AppShell.Navbar>
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/registry" element={<RegistryBrowserPage />} />
          <Route path="/submit/manual" element={<SubmitManualPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          {user.role === 'admin' && <Route path="/admin" element={<AdminPage />} />}
          {user.role === 'admin' && <Route path="/admin/settings" element={<AdminSettingsPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
    </SubmitDraftProvider>
  )
}
