import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MantineProvider, createTheme } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import './styles.css'
import { App } from './App'
import { useTheme } from './state/theme'
import { usePersonalTheme } from './state/personalTheme'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

function ThemedApp() {
  const t = useTheme()
  const personal = usePersonalTheme()
  // Personal primary color wins over admin default; falls through to 'blue'.
  const mantineTheme = createTheme({
    primaryColor: personal.primary_color ?? t.data?.primary_color ?? 'blue',
  })
  return (
    <MantineProvider
      theme={mantineTheme}
      defaultColorScheme="dark"
      forceColorScheme={t.data?.color_scheme === 'auto' ? undefined : t.data?.color_scheme}
    >
      <Notifications position="top-right" />
      <App />
    </MantineProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemedApp />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
