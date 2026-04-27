/**
 * Email-verification landing page. Hit by clicking the link in the
 * verification email; calls /auth/verify-email and shows the result.
 */
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Alert, Anchor, Button, Container, Loader, Paper, Stack, Title } from '@mantine/core'
import { api, ApiError } from '../api/client'

export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const [state, setState] = useState<'pending' | 'ok' | 'err'>('pending')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const token = params.get('token')
    if (!token) { setState('err'); setMessage('Missing token'); return }
    api
      .get(`/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(() => setState('ok'))
      .catch((err) => {
        setState('err')
        setMessage(err instanceof ApiError ? JSON.stringify(err.body) : 'Verification failed')
      })
  }, [params])

  return (
    <Container size={420} my={60}>
      <Title order={2} ta="center" mb="lg">Email verification</Title>
      <Paper withBorder shadow="sm" p={30} radius="md">
        <Stack>
          {state === 'pending' && <Loader />}
          {state === 'ok' && (
            <Alert color="green" title="Email verified">
              Your email is now confirmed. You can submit mods immediately.
            </Alert>
          )}
          {state === 'err' && (
            <Alert color="red" title="Verification failed">
              {message ?? 'The link may be expired or already used. Request a new one from your dashboard.'}
            </Alert>
          )}
          <Button component={Link} to="/" variant="light">
            Back to dashboard
          </Button>
          <Anchor component={Link} to="/login" ta="center" size="sm">
            Sign in
          </Anchor>
        </Stack>
      </Paper>
    </Container>
  )
}
