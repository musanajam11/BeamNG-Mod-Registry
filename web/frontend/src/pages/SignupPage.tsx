import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Anchor, Button, Container, Paper, PasswordInput, Stack, TextInput, Title, Alert, Text } from '@mantine/core'
import { api, ApiError, type User } from '../api/client'
import { Turnstile } from '../components/Turnstile'

interface AuthConfig {
  turnstile_site_key: string | null
  email_verification_required: boolean
}

export function SignupPage({ onSuccess }: { onSuccess: () => void }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cfg, setCfg] = useState<AuthConfig | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)

  useEffect(() => {
    api.get<AuthConfig>('/auth/config').then(setCfg).catch(() => setCfg(null))
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (cfg?.turnstile_site_key && !turnstileToken) {
      setError('Please complete the captcha.')
      return
    }
    setBusy(true)
    try {
      await api.post<{ user: User }>('/auth/signup', {
        email,
        password,
        display_name: displayName,
        turnstile_token: turnstileToken ?? undefined,
      })
      onSuccess()
      navigate('/')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Signup failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container size={420} my={60}>
      <Title order={2} ta="center" mb="lg">Create an account</Title>
      <Paper withBorder shadow="sm" p={30} radius="md">
        <form onSubmit={submit}>
          <Stack>
            <TextInput label="Display name" required minLength={2} maxLength={64}
              value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} />
            <TextInput label="Email" type="email" required
              value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
            <PasswordInput label="Password" required minLength={12}
              description="At least 12 characters."
              value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
            <Text size="xs" c="dimmed">
              New accounts start at the <strong>yellow</strong> trust tier — submissions
              are queued for moderator review until promoted.
              {cfg?.email_verification_required && (
                <> A verification email will be sent — confirm it before submitting.</>
              )}
            </Text>
            {cfg?.turnstile_site_key && (
              <Turnstile
                siteKey={cfg.turnstile_site_key}
                onToken={setTurnstileToken}
                onExpire={() => setTurnstileToken(null)}
              />
            )}
            {error && <Alert color="red">{error}</Alert>}
            <Button type="submit" loading={busy}>Create account</Button>
            <Anchor component={Link} to="/login" ta="center" size="sm">
              Already have an account? Sign in
            </Anchor>
          </Stack>
        </form>
      </Paper>
    </Container>
  )
}
