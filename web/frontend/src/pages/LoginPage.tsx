import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Anchor, Button, Container, Paper, PasswordInput, Stack, TextInput, Title, Alert } from '@mantine/core'
import { api, ApiError, type User } from '../api/client'

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.post<{ user: User }>('/auth/login', { email, password })
      onSuccess()
      navigate('/')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container size={420} my={60}>
      <Title order={2} ta="center" mb="lg">Sign in</Title>
      <Paper withBorder shadow="sm" p={30} radius="md">
        <form onSubmit={submit}>
          <Stack>
            <TextInput label="Email" type="email" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
            <PasswordInput label="Password" required value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
            {error && <Alert color="red">{error}</Alert>}
            <Button type="submit" loading={busy}>Sign in</Button>
            <Anchor component={Link} to="/signup" ta="center" size="sm">
              Don't have an account? Sign up
            </Anchor>
          </Stack>
        </form>
      </Paper>
    </Container>
  )
}
