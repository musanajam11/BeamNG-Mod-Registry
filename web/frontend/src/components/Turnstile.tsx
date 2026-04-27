/**
 * Tiny Cloudflare Turnstile widget binding. Loads the script lazily, mounts
 * the widget into a div ref, and calls back with the token. Designed so the
 * parent owns the token state.
 */
import { useEffect, useRef } from 'react'

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string
      callback?: (token: string) => void
      'error-callback'?: () => void
      'expired-callback'?: () => void
      theme?: 'light' | 'dark' | 'auto'
    }
  ) => string
  reset: (widgetId?: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptPromise: Promise<void> | null = null
function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SCRIPT_SRC
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('failed to load turnstile'))
    document.head.appendChild(s)
  })
  return scriptPromise
}

export interface TurnstileProps {
  siteKey: string
  onToken: (token: string) => void
  onExpire?: () => void
  theme?: 'light' | 'dark' | 'auto'
}

export function Turnstile({ siteKey, onToken, onExpire, theme = 'auto' }: TurnstileProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const widgetId = useRef<string | null>(null)
  const onTokenRef = useRef(onToken)
  const onExpireRef = useRef(onExpire)
  onTokenRef.current = onToken
  onExpireRef.current = onExpire

  useEffect(() => {
    let cancelled = false
    loadScript().then(() => {
      if (cancelled || !ref.current || !window.turnstile) return
      widgetId.current = window.turnstile.render(ref.current, {
        sitekey: siteKey,
        theme,
        callback: (t) => onTokenRef.current(t),
        'expired-callback': () => onExpireRef.current?.(),
        'error-callback': () => onExpireRef.current?.(),
      })
    })
    return () => {
      cancelled = true
      if (widgetId.current && window.turnstile) {
        try { window.turnstile.remove(widgetId.current) } catch { /* noop */ }
      }
    }
  }, [siteKey, theme])

  return <div className="turnstile-wrap" ref={ref} />
}
