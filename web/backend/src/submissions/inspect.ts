/**
 * BeamNG mod zip inspector.
 *
 * Reads a zip archive's central directory (no full extraction), looks for
 * BeamNG-conventional metadata files (`info.json`) and known directory
 * patterns to suggest:
 *   - mod_type   (vehicle / map / skin / ui_app / sound / scenario)
 *   - name, author, description (from info.json if present)
 *   - multiplayer_scope (detects Resources/Client and Resources/Server layout)
 *   - $kref hints (from URLs in info.json — best-effort)
 *
 * Designed to be defensive: every parser failure falls through silently so
 * one weird mod can't break the inspect endpoint.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import yauzl from 'yauzl'
import {
  collectLuaSignals, collectPathSignals, decideScope,
  type ScopeSignal,
} from './multiplayerScope.js'
void Readable

const MAX_INFO_JSON_BYTES = 1 * 1024 * 1024 // 1 MB cap per metadata file
/** Cap how many Lua files we sniff for BeamMP API calls, total. */
const MAX_LUA_SAMPLE_FILES = 8
/** Cap how many bytes per Lua file we read while sniffing. */
const MAX_LUA_SAMPLE_BYTES_PER_FILE = 64 * 1024
/** Cap total Lua bytes pulled across all sampled files. */
const MAX_LUA_SAMPLE_BYTES_TOTAL = 256 * 1024

export interface InspectSuggestions {
  name?: string
  author?: string
  description?: string
  mod_type?: string
  multiplayer_scope?: 'client' | 'server' | 'both'
  /** Confidence (0–100) and human-readable reasons for the scope pick. */
  multiplayer_scope_confidence?: number
  multiplayer_scope_reasons?: string[]
  has_resources_layout?: boolean
  thumbnail_path?: string
  detected_files?: string[]
  inner_zips?: string[]
}

export interface InspectResult {
  sha256: string
  size: number
  file_count: number
  suggestions: InspectSuggestions
  warnings: string[]
}

interface ZipEntryLite {
  fileName: string
  uncompressedSize: number
}

function listEntries(filePath: string): Promise<ZipEntryLite[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('failed to open zip'))
      const entries: ZipEntryLite[] = []
      zipfile.on('entry', (entry) => {
        entries.push({ fileName: entry.fileName, uncompressedSize: entry.uncompressedSize })
        zipfile.readEntry()
      })
      zipfile.on('end', () => resolve(entries))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

function readEntry(filePath: string, target: string, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return resolve(null)
      let resolved = false
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== target) {
          zipfile.readEntry()
          return
        }
        if (entry.uncompressedSize > maxBytes) {
          resolved = true
          zipfile.close()
          return resolve(null)
        }
        zipfile.openReadStream(entry, (rerr, stream) => {
          if (rerr || !stream) {
            resolved = true
            zipfile.close()
            return resolve(null)
          }
          const chunks: Buffer[] = []
          stream.on('data', (c: Buffer) => chunks.push(c))
          stream.on('end', () => {
            resolved = true
            zipfile.close()
            resolve(Buffer.concat(chunks).toString('utf-8'))
          })
          stream.on('error', () => {
            resolved = true
            zipfile.close()
            resolve(null)
          })
        })
      })
      zipfile.on('end', () => {
        if (!resolved) resolve(null)
      })
      zipfile.on('error', () => {
        if (!resolved) resolve(null)
      })
      zipfile.readEntry()
    })
  })
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function pick(obj: unknown, ...keys: string[]): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function detectModType(paths: string[]): string | undefined {
  // Resources/Client/<inner>.zip → look INSIDE the inner zip for true type;
  //   for now we mark as 'other' if the outer is Resources-layout only.
  const lower = paths.map((p) => p.toLowerCase())
  const has = (re: RegExp) => lower.some((p) => re.test(p))
  if (has(/(^|\/)vehicles\//)) return 'vehicle'
  if (has(/(^|\/)levels\//)) return 'map'
  if (has(/(^|\/)scenarios\//)) return 'scenario'
  if (has(/(^|\/)ui\/modules\//)) return 'ui_app'
  if (has(/(^|\/)art\/sound\//) || has(/\.(ogg|wav)$/)) return 'sound'
  if (has(/(^|\/)art\/skins\//)) return 'skin'
  return undefined
}

function detectMultiplayerScope(paths: string[]): {
  scope?: 'client' | 'server' | 'both'
  hasResources: boolean
} {
  const lower = paths.map((p) => p.toLowerCase())
  const hasClient = lower.some((p) => p.startsWith('resources/client/'))
  const hasServer = lower.some((p) => p.startsWith('resources/server/'))
  if (hasClient && hasServer) return { scope: 'both', hasResources: true }
  if (hasServer && !hasClient) return { scope: 'server', hasResources: true }
  if (hasClient && !hasServer) return { scope: 'client', hasResources: true }
  return { hasResources: false }
}

function findFirst<T>(arr: T[], pred: (t: T) => boolean): T | undefined {
  for (const x of arr) if (pred(x)) return x
  return undefined
}

export interface InspectProgressHook {
  (e: {
    phase: 'received' | 'hashing' | 'listing' | 'analyzing' | 'reading_metadata' | 'done'
    percent?: number
    detail?: string
    /** Bytes per second during the hashing phase. */
    bytes_per_sec?: number
    /** Seconds remaining for the current phase, when computable. */
    eta_sec?: number
  }): void
}

export async function inspectZip(
  filePath: string,
  opts: { onProgress?: InspectProgressHook } = {}
): Promise<InspectResult> {
  const warnings: string[] = []
  const stats = await stat(filePath)
  const onProgress = opts.onProgress ?? (() => {})
  onProgress({ phase: 'received', detail: `${(stats.size / (1024 * 1024)).toFixed(1)} MiB` })

  // Hash + size pass — independent of zip parsing so we always return them.
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(filePath)
    let hashed = 0
    let lastEmit = 0
    const start = Date.now()
    s.on('data', (c: string | Buffer) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c
      hash.update(buf)
      hashed += buf.length
      const pct = stats.size > 0 ? Math.floor((hashed / stats.size) * 100) : 0
      // Throttle to ~10 events/s worth of meaningful jumps.
      if (pct >= lastEmit + 2 || pct === 100) {
        lastEmit = pct
        const elapsedMs = Math.max(1, Date.now() - start)
        const bps = (hashed / elapsedMs) * 1000
        const remainingBytes = Math.max(0, stats.size - hashed)
        const etaSec = bps > 0 ? Math.round(remainingBytes / bps) : undefined
        onProgress({
          phase: 'hashing',
          percent: pct,
          bytes_per_sec: Math.round(bps),
          eta_sec: etaSec,
        })
      }
    })
    s.on('end', () => resolve())
    s.on('error', reject)
  })
  const sha256 = hash.digest('hex')

  onProgress({ phase: 'listing', detail: 'reading central directory' })
  let entries: ZipEntryLite[] = []
  try {
    entries = await listEntries(filePath)
  } catch (err) {
    warnings.push(`zip parse failed: ${(err as Error).message}`)
    return {
      sha256,
      size: stats.size,
      file_count: 0,
      suggestions: {},
      warnings,
    }
  }

  const filePaths = entries.map((e) => e.fileName)
  const suggestions: InspectSuggestions = {}

  onProgress({ phase: 'analyzing', detail: `${entries.length.toLocaleString()} entries` })

  // Multiplayer scope detection: combine path-based signals with a small
  // sample of Lua source so we can spot BeamMP server/client API calls and
  // tell apart server-side mods that auto-distribute their client portion.
  const scopeSignals: ScopeSignal[] = collectPathSignals(filePaths)
  const mpLegacy = detectMultiplayerScope(filePaths)
  suggestions.has_resources_layout = mpLegacy.hasResources

  // Pick a handful of small Lua files and read up to a cap each. Prefer
  // files under Resources/{Server,Client} so the sample is BeamMP-relevant
  // when those directories exist.
  const luaCandidates = entries
    .filter((e) => /\.lua$/i.test(e.fileName) && e.uncompressedSize > 0 && e.uncompressedSize <= MAX_LUA_SAMPLE_BYTES_PER_FILE)
    .sort((a, b) => {
      const score = (n: string) => /resources\/(server|client)\//i.test(n) ? 0 : 1
      return score(a.fileName) - score(b.fileName) || a.uncompressedSize - b.uncompressedSize
    })
    .slice(0, MAX_LUA_SAMPLE_FILES)
  let luaSample = ''
  for (const e of luaCandidates) {
    if (luaSample.length >= MAX_LUA_SAMPLE_BYTES_TOTAL) break
    const text = await readEntry(filePath, e.fileName, MAX_LUA_SAMPLE_BYTES_PER_FILE)
    if (text) luaSample += '\n' + text
  }
  if (luaSample) scopeSignals.push(...collectLuaSignals(luaSample))

  const decision = decideScope(scopeSignals)
  if (decision.scope) {
    suggestions.multiplayer_scope = decision.scope
    suggestions.multiplayer_scope_confidence = decision.confidence
    // Dedupe reasons so the UI doesn't show the same line twice.
    suggestions.multiplayer_scope_reasons = Array.from(
      new Set(decision.signals.map((s) => s.reason))
    )
  } else if (decision.is_multiplayer) {
    // We saw multiplayer hints but couldn't confidently pick a side —
    // surface that to the user as a hint without committing.
    suggestions.multiplayer_scope_reasons = Array.from(
      new Set(decision.signals.map((s) => s.reason))
    )
  }

  // Mod type from outer file paths.
  const modType = detectModType(filePaths)
  if (modType) suggestions.mod_type = modType

  // Find the first BeamNG info.json (vehicles/<name>/info.json, levels/<name>/info.json).
  const infoEntry = findFirst(
    entries,
    (e) => /(^|\/)(vehicles|levels|scenarios)\/[^/]+\/info\.json$/i.test(e.fileName)
  )
  if (infoEntry) {
    onProgress({ phase: 'reading_metadata', detail: infoEntry.fileName })
    const raw = await readEntry(filePath, infoEntry.fileName, MAX_INFO_JSON_BYTES)
    if (raw) {
      const parsed = safeJsonParse(raw)
      if (parsed && typeof parsed === 'object') {
        const name = pick(parsed, 'Name', 'name')
        const author = pick(parsed, 'Author', 'author')
        const description = pick(parsed, 'Description', 'description')
        if (name) suggestions.name = name
        if (author) suggestions.author = author
        if (description) suggestions.description = description
      } else {
        warnings.push(`could not parse ${infoEntry.fileName}`)
      }
    }
  }

  // Look for an obvious thumbnail.
  const thumb = findFirst(entries, (e) =>
    /thumbnail\.(png|jpe?g|webp)$/i.test(e.fileName) || /default\.jpe?g$/i.test(e.fileName)
  )
  if (thumb) suggestions.thumbnail_path = thumb.fileName

  // Track inner zips (Resources/Client/<mod>.zip) for diagnostic display.
  const innerZips = filePaths.filter(
    (p) => /^resources\/client\//i.test(p) && p.toLowerCase().endsWith('.zip')
  )
  if (innerZips.length) suggestions.inner_zips = innerZips

  // Provide a small sample of detected files for the UI.
  suggestions.detected_files = filePaths.slice(0, 50)

  onProgress({ phase: 'done' })
  return {
    sha256,
    size: stats.size,
    file_count: entries.length,
    suggestions,
    warnings,
  }
}
