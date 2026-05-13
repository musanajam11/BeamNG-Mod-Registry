/**
 * Heuristic multiplayer-scope detection for BeamMP-related mods.
 *
 * Returns a `'client' | 'server' | 'both' | undefined` decision plus a
 * confidence score and an audit trail of signals so the UI can explain
 * why we picked it. Same module is fed by:
 *
 *   - Zip inspection — file paths inside the uploaded zip + (optionally)
 *     the contents of small `.lua` files we already had to read.
 *   - GitHub lookup — the recursive repo tree, README markdown, and
 *     repository topics.
 *   - BeamNG.com lookup — the resource description / tagline text.
 *
 * Signals are weighted; the highest-scoring candidate wins as long as it
 * crosses a small threshold. A "both" decision can also be triggered when
 * we see strong evidence of *both* roles (e.g. CareerMP-style mods that
 * ship the client mod inside `Resources/Client/` and the plugin inside
 * `Resources/Server/`).
 */

export type MpScope = 'client' | 'server' | 'both'

export interface ScopeSignal {
  /** Which role this signal supports. */
  role: 'client' | 'server'
  /** Free-form explanation shown to the user (e.g. "Resources/Server/ folder"). */
  reason: string
  /** Positive integer weight; 1 = weak, 3 = strong, 5 = decisive. */
  weight: number
}

export interface ScopeDetection {
  scope?: MpScope
  /** 0–100 rough confidence ("how strong is the evidence"). */
  confidence: number
  /** All signals we observed, regardless of which role won. */
  signals: ScopeSignal[]
  /** True if the mod looks BeamMP-related at all (any signal matched). */
  is_multiplayer: boolean
}

// ── Signal libraries ───────────────────────────────────────────────────────

/**
 * Path-based signals. Tested case-insensitively against either:
 *   a) zip entry paths ("resources/server/foo/bar.lua") or
 *   b) GitHub tree paths (same convention)
 *
 * Order matters only for documentation — every signal is checked.
 */
const PATH_SIGNALS: { re: RegExp; role: 'client' | 'server'; reason: string; weight: number }[] = [
  // Canonical BeamMP server install layout.
  { re: /(^|\/)resources\/server\//i, role: 'server', reason: 'Resources/Server/ directory (BeamMP server install path)', weight: 5 },
  { re: /(^|\/)resources\/client\//i, role: 'client', reason: 'Resources/Client/ directory (BeamMP client install path)', weight: 5 },

  // Server-only Lua artifacts BeamMP plugins commonly ship.
  { re: /(^|\/)serverscripts?\//i, role: 'server', reason: 'ServerScripts/ directory', weight: 3 },
  { re: /(^|\/)serverconfig\.toml$/i, role: 'server', reason: 'ServerConfig.toml at root', weight: 4 },
  { re: /(^|\/)beammp[-_]?server[-_.]/i, role: 'server', reason: 'BeamMP-Server filename prefix', weight: 2 },
  { re: /(^|\/)plugins?\/[^/]+\/main\.lua$/i, role: 'server', reason: 'plugins/<name>/main.lua (BeamMP plugin entry)', weight: 4 },

  // Client-only artifacts.
  { re: /(^|\/)mods\/(repo|unpacked)\//i, role: 'client', reason: 'mods/repo|unpacked/ directory (game client layout)', weight: 3 },
  { re: /(^|\/)scripts\/client\//i, role: 'client', reason: 'scripts/client/ directory', weight: 2 },
]

/**
 * Lua source-content signals. Run on a *concatenated* sample of Lua source
 * code (we cap how much we read, see callers). All matches contribute.
 */
const LUA_SIGNALS: { re: RegExp; role: 'client' | 'server'; reason: string; weight: number }[] = [
  // BeamMP server-side plugin API (only available in the server's Lua VM).
  { re: /\bMP\.RegisterEvent\s*\(/, role: 'server', reason: 'MP.RegisterEvent() (BeamMP server Lua API)', weight: 5 },
  { re: /\bMP\.TriggerClientEvent\s*\(/, role: 'server', reason: 'MP.TriggerClientEvent() (server → client)', weight: 5 },
  { re: /\bMP\.TriggerGlobalEvent\s*\(/, role: 'server', reason: 'MP.TriggerGlobalEvent() (server-side)', weight: 4 },
  { re: /\bMP\.SendChatMessage\s*\(/, role: 'server', reason: 'MP.SendChatMessage() (server-side)', weight: 4 },
  { re: /\bMP\.GetPlayer(?:Name|Count|Vehicles)/, role: 'server', reason: 'MP.GetPlayer*() (server-side query)', weight: 3 },
  { re: /\bMP\.CreateEventTimer\s*\(/, role: 'server', reason: 'MP.CreateEventTimer() (server-side)', weight: 3 },
  { re: /\bonPlayerConnecting\b/, role: 'server', reason: 'onPlayerConnecting handler (server event)', weight: 4 },
  { re: /\bonPlayerJoin(?:ing)?\b/, role: 'server', reason: 'onPlayerJoin/Joining handler (server event)', weight: 3 },
  { re: /\bonChatMessage\b/, role: 'server', reason: 'onChatMessage handler (server event)', weight: 2 },
  { re: /\bonVehicleSpawn\b/, role: 'server', reason: 'onVehicleSpawn handler (server event)', weight: 2 },
  { re: /\bUtil\.LogInfo\s*\(/, role: 'server', reason: 'Util.LogInfo() (BeamMP server Lua)', weight: 1 },
  { re: /\brequire\(['"]ServerScripts\b/, role: 'server', reason: 'require("ServerScripts/...") (server entry)', weight: 4 },

  // BeamMP client-side Lua API (game client only).
  { re: /\bMPGameNetwork\b/, role: 'client', reason: 'MPGameNetwork module (BeamMP client Lua)', weight: 5 },
  { re: /\bMPVehicleGE\b/, role: 'client', reason: 'MPVehicleGE module (BeamMP client Lua)', weight: 4 },
  { re: /\bMPCoreNetwork\b/, role: 'client', reason: 'MPCoreNetwork module (BeamMP client Lua)', weight: 4 },
  { re: /\bbe:queueLuaCommand/, role: 'client', reason: 'be:queueLuaCommand (game client API)', weight: 1 },

  // BeamMP client UI conventions inside `ui/modules/apps/...`
  { re: /\bregisterCoreModule\s*\(\s*['"][^'"]+['"]\s*\)/, role: 'client', reason: 'registerCoreModule() (game client extension)', weight: 1 },
]

/**
 * README / description text signals. Matched case-insensitively against
 * the rendered/markdown text (we don't need to be precise — these are
 * tie-breakers, not primary evidence).
 */
const TEXT_SIGNALS: { re: RegExp; role: 'client' | 'server'; reason: string; weight: number }[] = [
  // Very strong: explicit install instruction phrasing.
  { re: /resources\/server/i, role: 'server', reason: 'README mentions Resources/Server install path', weight: 4 },
  { re: /resources\/client/i, role: 'client', reason: 'README mentions Resources/Client install path', weight: 4 },
  { re: /serverconfig\.toml/i, role: 'server', reason: 'README references ServerConfig.toml', weight: 3 },
  { re: /\bbeammp\s+server\b/i, role: 'server', reason: 'README mentions "BeamMP server"', weight: 3 },
  { re: /\bbeammp[- ]?plugin\b/i, role: 'server', reason: 'README describes a BeamMP plugin', weight: 3 },
  { re: /\bserver[- ]?side\b/i, role: 'server', reason: 'README says "server-side"', weight: 2 },
  { re: /\bclient[- ]?side\b/i, role: 'client', reason: 'README says "client-side"', weight: 2 },
  { re: /\bdrop\s+(?:this\s+)?into\s+(?:your\s+)?(?:beammp\s+)?server\b/i, role: 'server', reason: 'README install line targets a BeamMP server', weight: 3 },
  { re: /\binstall(?:s|ed)?\s+(?:on\s+|to\s+)?(?:the\s+)?client(?:s)?\b/i, role: 'client', reason: 'README mentions client-side install', weight: 2 },
]

/**
 * Bidirectional text signals — a single phrase that is strong evidence the
 * mod has BOTH a server and a client component. Each match contributes a
 * weighted signal to *both* roles, which is how we promote the decision to
 * `'both'` for server-side mods that auto-distribute their client part
 * (e.g. CareerMP fetches its client zip on first server start).
 */
const BOTH_TEXT_SIGNALS: { re: RegExp; reason: string; weight: number }[] = [
  { re: /\bfetch(?:es|ed)?\s+(?:a\s+)?client\s+mod\b/i, reason: 'README mentions auto-fetching the client mod', weight: 4 },
  { re: /\bauto[- ]?(?:install|distribut)\w*\s+(?:to|on|for)\s+client/i, reason: 'README mentions auto-installing the client portion', weight: 4 },
  { re: /\bclient\s+(?:will\s+be\s+)?(?:auto[- ]?)?download(?:ed)?\s+(?:from|by)\s+(?:the\s+)?server/i, reason: 'README says the client mod is downloaded from the server', weight: 4 },
  { re: /\bboth\s+(?:a\s+)?client\s+and\s+(?:a\s+)?server\b/i, reason: 'README explicitly says "both client and server"', weight: 3 },
]

/**
 * GitHub topic → role hints. Topic strings are normalised lowercase.
 * `beammp` alone is ambiguous (could be either) so it doesn't pick a side.
 */
const TOPIC_SIGNALS: Record<string, { role: 'client' | 'server'; reason: string; weight: number }> = {
  'beammp-server': { role: 'server', reason: 'GitHub topic: beammp-server', weight: 4 },
  'beammp-plugin': { role: 'server', reason: 'GitHub topic: beammp-plugin', weight: 4 },
  'beammp-mod': { role: 'client', reason: 'GitHub topic: beammp-mod', weight: 2 },
  'beammp-client': { role: 'client', reason: 'GitHub topic: beammp-client', weight: 4 },
}

// ── Signal collectors ──────────────────────────────────────────────────────

/** Push every path-signal that fires for any of the supplied paths. */
export function collectPathSignals(paths: string[]): ScopeSignal[] {
  const out: ScopeSignal[] = []
  const seen = new Set<string>()
  for (const sig of PATH_SIGNALS) {
    if (paths.some((p) => sig.re.test(p))) {
      const key = `${sig.role}:${sig.reason}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ role: sig.role, reason: sig.reason, weight: sig.weight })
    }
  }
  return out
}

/** Push every Lua-content signal that fires in the concatenated sample. */
export function collectLuaSignals(luaSample: string): ScopeSignal[] {
  if (!luaSample) return []
  const out: ScopeSignal[] = []
  for (const sig of LUA_SIGNALS) {
    if (sig.re.test(luaSample)) {
      out.push({ role: sig.role, reason: sig.reason, weight: sig.weight })
    }
  }
  return out
}

/** Push every text signal that fires in README / description text. */
export function collectTextSignals(text: string): ScopeSignal[] {
  if (!text) return []
  const out: ScopeSignal[] = []
  for (const sig of TEXT_SIGNALS) {
    if (sig.re.test(text)) {
      out.push({ role: sig.role, reason: sig.reason, weight: sig.weight })
    }
  }
  // Bidirectional phrases contribute to BOTH sides so the decision tips to
  // 'both' even when the file tree alone only proves one side.
  for (const sig of BOTH_TEXT_SIGNALS) {
    if (sig.re.test(text)) {
      out.push({ role: 'server', reason: sig.reason, weight: sig.weight })
      out.push({ role: 'client', reason: sig.reason, weight: sig.weight })
    }
  }
  return out
}

/** Push topic-derived signals; `topics` is an array of normalised strings. */
export function collectTopicSignals(topics: string[]): ScopeSignal[] {
  const out: ScopeSignal[] = []
  for (const t of topics) {
    const sig = TOPIC_SIGNALS[t.toLowerCase()]
    if (sig) out.push({ role: sig.role, reason: sig.reason, weight: sig.weight })
  }
  return out
}

// ── Decision ───────────────────────────────────────────────────────────────

/** How much weight each side needs before we'll commit to a decision. */
const DECISION_THRESHOLD = 3
/** Minimum side-weight (relative to the winner) to upgrade to "both". */
const BOTH_RATIO = 0.5

/**
 * Reduce a mixed bag of signals to a single decision. The caller can pass
 * many signals — collect from every source you have available; this keeps
 * the scoring math in one place.
 */
export function decideScope(signals: ScopeSignal[]): ScopeDetection {
  if (signals.length === 0) {
    return { confidence: 0, signals: [], is_multiplayer: false }
  }
  let server = 0
  let client = 0
  for (const s of signals) {
    if (s.role === 'server') server += s.weight
    else client += s.weight
  }
  const total = server + client
  const winner = server === client ? null : server > client ? 'server' : 'client'
  const winnerWeight = Math.max(server, client)
  const loserWeight = Math.min(server, client)

  let scope: MpScope | undefined
  if (winnerWeight < DECISION_THRESHOLD) {
    // Too weak — looks multiplayer-related but not enough to commit.
    scope = undefined
  } else if (loserWeight >= DECISION_THRESHOLD && loserWeight / winnerWeight >= BOTH_RATIO) {
    scope = 'both'
  } else if (winner) {
    scope = winner
  } else {
    // Equal non-zero weights → call it 'both'.
    scope = 'both'
  }

  // Confidence: cap at 100. Saturates around weight 12.
  const confidence = Math.min(100, Math.round((winnerWeight / 12) * 100))
  return { scope, confidence, signals, is_multiplayer: total > 0 }
}
