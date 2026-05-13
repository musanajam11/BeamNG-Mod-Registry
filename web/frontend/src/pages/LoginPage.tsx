import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Anchor, Button, Container, Image, Paper, PasswordInput, Stack, TextInput, Alert } from '@mantine/core'
import { api, ApiError, type User } from '../api/client'
import { Turnstile } from '../components/Turnstile'
import { DiscordLink } from '../components/DiscordLink'

interface AuthConfig {
  turnstile_site_key: string | null
  email_verification_required: boolean
}

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const cfg = useQuery({
    queryKey: ['auth', 'config'],
    queryFn: () => api.get<AuthConfig>('/auth/config'),
  })
  const siteKey = cfg.data?.turnstile_site_key ?? null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (siteKey && !turnstileToken) {
      setError('Please complete the verification challenge')
      return
    }
    setBusy(true)
    try {
      await api.post<{ user: User }>('/auth/login', {
        email,
        password,
        turnstile_token: turnstileToken ?? undefined,
      })
      onSuccess()
      navigate('/')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-bg">
      <Container size={420} w="100%">
        <Image
          src="/logo.png"
          alt="BeamNG Mod Registry"
          w={180}
          h={180}
          fit="contain"
          mx="auto"
          mb="md"
        />
        <Paper withBorder shadow="sm" p={30} radius="md">
          <form onSubmit={submit}>
            <Stack>
              <TextInput label="Email" type="email" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
              <PasswordInput label="Password" required value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
              {siteKey && (
                <Turnstile
                  siteKey={siteKey}
                  onToken={setTurnstileToken}
                  onExpire={() => setTurnstileToken(null)}
                />
              )}
              {error && <Alert color="red">{error}</Alert>}
              <Button type="submit" loading={busy} disabled={Boolean(siteKey) && !turnstileToken}>Sign in</Button>
              <Anchor component={Link} to="/signup" ta="center" size="sm">
                Don't have an account? Sign up
              </Anchor>
              <Anchor component={Link} to="/registry" ta="center" size="sm">
                Browse the registry without signing in
              </Anchor>
              <Anchor component={Link} to="/faq" ta="center" size="sm">
                Read the FAQ / wiki
              </Anchor>
              <Anchor component={Link} to="/content-manager" ta="center" size="sm" c="dimmed">
                Get the BeamNG Content Manager desktop app
              </Anchor>
              <DiscordLink label="Questions? Join the Discord" fullWidth />
            </Stack>
          </form>
        </Paper>
      </Container>
    </div>
  )
}
