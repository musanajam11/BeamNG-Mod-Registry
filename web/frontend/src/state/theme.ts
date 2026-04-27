/**
 * Theme bootstrap. Fetches admin-configured theme from /api/theme and:
 *   1. Sets CSS custom properties on :root so styles.css can react to them.
 *   2. Returns the theme object so MantineProvider can pick up
 *      primaryColor / forceColorScheme.
 *
 * Cached via React Query so the rest of the app can read the same data
 * without re-fetching.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { usePersonalTheme, type PersonalThemeOverrides } from './personalTheme'

export interface ThemeConfig {
  background_url: string
  background_blur_px: number
  background_dim_pct: number
  primary_color: string
  color_scheme: 'auto' | 'light' | 'dark'
  app_name: string
  apply_to_auth_only: boolean
}

export const THEME_QUERY_KEY = ['theme'] as const

export function useTheme() {
  return useQuery({
    queryKey: THEME_QUERY_KEY,
    queryFn: () => api.get<ThemeConfig>('/theme'),
    staleTime: 60_000,
  })
}

/**
 * Merge admin theme + per-user overrides. Personal values win when set;
 * `null` falls through to the admin default.
 */
export function mergeTheme(
  base: ThemeConfig | undefined,
  personal: PersonalThemeOverrides,
): ThemeConfig | undefined {
  if (!base) return base
  return {
    ...base,
    background_url: personal.background_url ?? base.background_url,
    background_blur_px: personal.background_blur_px ?? base.background_blur_px,
    background_dim_pct: personal.background_dim_pct ?? base.background_dim_pct,
    primary_color: personal.primary_color ?? base.primary_color,
  }
}

export function applyThemeVars(theme: ThemeConfig | undefined): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (!theme) return
  root.style.setProperty('--bg-image', `url("${cssEscapeUrl(theme.background_url)}")`)
  root.style.setProperty('--bg-blur', `${theme.background_blur_px}px`)
  // brightness factor: 0.45 dim => brightness(0.55)
  const brightness = Math.max(0.1, 1 - theme.background_dim_pct / 100)
  root.style.setProperty('--bg-brightness', String(brightness))
}

/** Escape a URL for safe use inside a CSS url("…") value. */
function cssEscapeUrl(url: string): string {
  return url.replace(/"/g, '%22').replace(/\\/g, '%5C')
}

/** Side-effect hook: applies the theme to :root every time the query
 *  data or personal overrides change. */
export function useApplyTheme(): ThemeConfig | undefined {
  const q = useTheme()
  const personal = usePersonalTheme()
  const merged = mergeTheme(q.data, personal)
  useEffect(() => {
    applyThemeVars(merged)
  }, [merged])
  return merged
}
