/**
 * Per-browser personal theme overrides. Stored in localStorage so they
 * survive reloads without a backend round-trip. Each field is optional —
 * `null`/missing means "use the admin-configured value".
 *
 * Subscribed via useSyncExternalStore so any component can read the live
 * value, including the top-level <ThemedApp /> in main.tsx that wires
 * primaryColor into MantineProvider.
 */
import { useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

interface MeUser {
  id: number
}

export interface PersonalThemeOverrides {
  background_url: string | null
  background_blur_px: number | null
  background_dim_pct: number | null
  primary_color: string | null
}

const EMPTY: PersonalThemeOverrides = {
  background_url: null,
  background_blur_px: null,
  background_dim_pct: null,
  primary_color: null,
}

const STORAGE_KEY = 'beamreg.personalTheme'

function read(): PersonalThemeOverrides {
  if (typeof localStorage === 'undefined') return EMPTY
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as Partial<PersonalThemeOverrides>
    return {
      background_url:
        typeof parsed.background_url === 'string' ? parsed.background_url : null,
      background_blur_px:
        typeof parsed.background_blur_px === 'number' ? parsed.background_blur_px : null,
      background_dim_pct:
        typeof parsed.background_dim_pct === 'number' ? parsed.background_dim_pct : null,
      primary_color:
        typeof parsed.primary_color === 'string' ? parsed.primary_color : null,
    }
  } catch {
    return EMPTY
  }
}

let snapshot: PersonalThemeOverrides = read()
const listeners = new Set<() => void>()

function emit(): void {
  // Stable identity for unchanged: useSyncExternalStore relies on
  // referential equality, so we always allocate a new object on write.
  for (const l of listeners) l()
}

export function getPersonalTheme(): PersonalThemeOverrides {
  return snapshot
}

export function setPersonalTheme(patch: Partial<PersonalThemeOverrides>): void {
  snapshot = { ...snapshot, ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* quota / privacy mode — fall through; in-memory state still updates */
  }
  emit()
}

export function resetPersonalTheme(): void {
  snapshot = { ...EMPTY }
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function usePersonalTheme(): PersonalThemeOverrides {
  const stored = useSyncExternalStore(subscribe, getPersonalTheme, getPersonalTheme)
  // Personal overrides only apply when the viewer is actually signed in.
  // Anonymous viewers (and signed-out sessions in the same browser) always
  // see the admin-configured theme, so personal preferences never leak to
  // visitors who didn't opt in. We piggy-back on the shared `['me']` query
  // populated by <App/> rather than re-fetching here; while it's loading we
  // conservatively treat the viewer as anonymous.
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: MeUser | null }>('/auth/me'),
  })
  if (!me.data?.user) return EMPTY
  return stored
}

/** Read the raw localStorage overrides regardless of sign-in state. The
 *  Profile page uses this so an admin (or any user) can configure their
 *  preferences without first being recognised as signed in by the merger. */
export function usePersonalThemeRaw(): PersonalThemeOverrides {
  return useSyncExternalStore(subscribe, getPersonalTheme, getPersonalTheme)
}
