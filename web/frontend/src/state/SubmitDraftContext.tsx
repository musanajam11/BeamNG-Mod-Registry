/**
 * Persistent draft state for the submission form. The provider is mounted
 * once at the AppShell level so navigating between tabs (Dashboard,
 * Registry Browser, …) does not unmount the underlying state, and a copy
 * is mirrored into `sessionStorage` so an accidental reload doesn't wipe
 * the user's in-progress draft either.
 *
 * The form components stay pure — they call `useSubmitDraft()` to read +
 * update fields, exactly like they used to with their local `useState`.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_FORM, type FormState } from '../pages/submit/formState'
import { loadFromBeammod } from '../pages/submit/loadFromBeammod'

const STORAGE_KEY = 'submit-draft-v1'

export interface InspectResult {
  sha256: string
  size: number
  file_count: number
  suggestions: {
    name?: string
    author?: string
    description?: string
    mod_type?: string
    multiplayer_scope?: 'client' | 'server' | 'both'
    has_resources_layout?: boolean
    thumbnail_path?: string
    detected_files?: string[]
    inner_zips?: string[]
  }
  warnings: string[]
}

export interface SubmitDraft {
  form: FormState
  setForm: (next: FormState | ((prev: FormState) => FormState)) => void
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void
  hashServerSide: boolean
  setHashServerSide: (v: boolean) => void
  autoUrl: string
  setAutoUrl: (v: string) => void
  inspectInfo: InspectResult | null
  setInspectInfo: (v: InspectResult | null) => void
  /**
   * If non-null, the user is proposing changes to an existing registry
   * entry; the value is the original identifier they're editing. Used by
   * the UI to surface a banner explaining the review process.
   */
  editingExisting: string | null
  /**
   * If non-null, the user is editing a submission that an admin asked
   * them to revise. The submit page POSTs to /submissions/mine/:id/resubmit
   * instead of creating a new row, preserving the original review thread.
   */
  resubmittingId: number | null
  setResubmittingId: (v: number | null) => void
  /** Pre-fill the form from an existing `.beammod` raw payload. */
  loadFromExisting: (raw: Record<string, unknown>, opts?: { bumpVersion?: boolean }) => void
  /** Wipe the draft (called after a successful submission). */
  reset: () => void
}

interface PersistedShape {
  form: FormState
  hashServerSide: boolean
  autoUrl: string
  inspectInfo: InspectResult | null
  editingExisting: string | null
  resubmittingId: number | null
}

function loadPersisted(): PersistedShape | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedShape>
    if (!parsed || typeof parsed !== 'object' || !parsed.form) return null
    // Merge defaults so adding a new form field doesn't break old drafts.
    return {
      form: { ...DEFAULT_FORM, ...parsed.form },
      hashServerSide: parsed.hashServerSide ?? true,
      autoUrl: parsed.autoUrl ?? '',
      inspectInfo: parsed.inspectInfo ?? null,
      editingExisting: parsed.editingExisting ?? null,
      resubmittingId: parsed.resubmittingId ?? null,
    }
  } catch {
    return null
  }
}

const Ctx = createContext<SubmitDraft | null>(null)

export function SubmitDraftProvider({ children }: { children: ReactNode }) {
  const initial = useRef<PersistedShape | null>(null)
  if (initial.current === null && typeof window !== 'undefined') {
    initial.current = loadPersisted()
  }

  const [form, setForm] = useState<FormState>(initial.current?.form ?? DEFAULT_FORM)
  const [hashServerSide, setHashServerSide] = useState<boolean>(initial.current?.hashServerSide ?? true)
  const [autoUrl, setAutoUrl] = useState<string>(initial.current?.autoUrl ?? '')
  const [inspectInfo, setInspectInfo] = useState<InspectResult | null>(initial.current?.inspectInfo ?? null)
  const [editingExisting, setEditingExisting] = useState<string | null>(initial.current?.editingExisting ?? null)
  const [resubmittingId, setResubmittingId] = useState<number | null>(initial.current?.resubmittingId ?? null)

  // Throttle persistence to once per animation frame so rapid keystrokes
  // don't thrash sessionStorage.
  useEffect(() => {
    const handle = window.requestAnimationFrame(() => {
      try {
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ form, hashServerSide, autoUrl, inspectInfo, editingExisting, resubmittingId })
        )
      } catch {
        /* quota exceeded — silently ignore */
      }
    })
    return () => window.cancelAnimationFrame(handle)
  }, [form, hashServerSide, autoUrl, inspectInfo, editingExisting, resubmittingId])

  const value = useMemo<SubmitDraft>(
    () => ({
      form,
      setForm,
      update: (key, value) => setForm((prev) => ({ ...prev, [key]: value })),
      hashServerSide,
      setHashServerSide,
      autoUrl,
      setAutoUrl,
      inspectInfo,
      setInspectInfo,
      editingExisting,
      resubmittingId,
      setResubmittingId,
      loadFromExisting: (raw, opts) => {
        const next = loadFromBeammod(raw)
        if (opts?.bumpVersion && next.version) {
          // naive patch bump: append `.1` if no dotted suffix, else +1 to last numeric chunk.
          const parts = next.version.split('.')
          const lastIdx = parts.length - 1
          const lastNum = Number(parts[lastIdx])
          if (Number.isFinite(lastNum)) {
            parts[lastIdx] = String(lastNum + 1)
            next.version = parts.join('.')
          }
        }
        setForm(next)
        setEditingExisting(typeof raw.identifier === 'string' ? raw.identifier : null)
        setInspectInfo(null)
        setAutoUrl('')
      },
      reset: () => {
        setForm(DEFAULT_FORM)
        setHashServerSide(true)
        setAutoUrl('')
        setInspectInfo(null)
        setEditingExisting(null)
        setResubmittingId(null)
        try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* noop */ }
      },
    }),
    [form, hashServerSide, autoUrl, inspectInfo, editingExisting, resubmittingId]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSubmitDraft(): SubmitDraft {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSubmitDraft must be used inside <SubmitDraftProvider>')
  return v
}
