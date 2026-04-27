/**
 * Tiny in-memory pub/sub for live "what is the inspector doing right now"
 * updates streamed to the browser via SSE. Keyed by a client-generated UUID
 * the upload request and the SSE listener both reference. Auto-evicts entries
 * after a short idle window so a crashed client can't leak memory.
 */

export type InspectPhase =
  | 'received'
  | 'hashing'
  | 'listing'
  | 'analyzing'
  | 'reading_metadata'
  | 'done'
  | 'error'

export interface InspectProgressEvent {
  phase: InspectPhase
  /** 0–100 when known; omit for indeterminate phases. */
  percent?: number
  /** Free-form short human label, e.g. "vehicles/myCar/info.json". */
  detail?: string
  /** Hashing throughput, when known. */
  bytes_per_sec?: number
  /** Seconds remaining for the current phase, when known. */
  eta_sec?: number
}

type Listener = (e: InspectProgressEvent) => void

interface Channel {
  listeners: Set<Listener>
  buffered: InspectProgressEvent[]
  lastTouched: number
}

const channels = new Map<string, Channel>()
const TTL_MS = 5 * 60 * 1000
const ID_RE = /^[A-Za-z0-9_-]{8,128}$/

function touch(id: string): Channel {
  let ch = channels.get(id)
  if (!ch) {
    ch = { listeners: new Set(), buffered: [], lastTouched: Date.now() }
    channels.set(id, ch)
  }
  ch.lastTouched = Date.now()
  return ch
}

export function isValidInspectId(id: string | undefined): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

export function emitInspectProgress(id: string | undefined, e: InspectProgressEvent): void {
  if (!isValidInspectId(id)) return
  const ch = touch(id)
  if (ch.listeners.size === 0) {
    // Buffer a small tail so a slow EventSource handshake still sees recent
    // events. Capped to keep memory bounded.
    ch.buffered.push(e)
    if (ch.buffered.length > 32) ch.buffered.shift()
  } else {
    for (const l of ch.listeners) {
      try { l(e) } catch { /* ignore listener errors */ }
    }
  }
  if (e.phase === 'done' || e.phase === 'error') {
    // Give the client a beat to drain, then close.
    setTimeout(() => closeInspectChannel(id), 5_000)
  }
}

export function subscribeInspect(id: string, listener: Listener): () => void {
  const ch = touch(id)
  ch.listeners.add(listener)
  // Drain any buffered events from before the SSE socket opened.
  for (const e of ch.buffered) {
    try { listener(e) } catch { /* ignore */ }
  }
  ch.buffered = []
  return () => {
    ch.listeners.delete(listener)
  }
}

export function closeInspectChannel(id: string): void {
  channels.delete(id)
}

// Periodic GC for stale channels (uploads aborted before completion).
setInterval(() => {
  const now = Date.now()
  for (const [id, ch] of channels) {
    if (ch.listeners.size === 0 && now - ch.lastTouched > TTL_MS) {
      channels.delete(id)
    }
  }
}, 60_000).unref()
