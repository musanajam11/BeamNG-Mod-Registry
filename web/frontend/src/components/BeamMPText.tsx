/**
 * BeamMP color and style code renderer.
 *
 * Server display names in BeamMP can carry inline formatting using `^`
 * escape codes (`^0`–`^f` for hex colors, `^l` bold, `^o` italic, `^n`
 * underline, `^m` strikethrough, `^r` reset). This renders them as styled
 * spans so backend listings here look the same as they do in Content
 * Manager and the in-game server browser.
 *
 * Mirrors the parser in BeamMP Content Manager
 * (`app/src/renderer/src/components/BeamMPText.tsx`) so behaviour stays
 * consistent across CM, BMR, and the directory page.
 */
import { useMemo } from 'react'
import type { CSSProperties, JSX, ReactNode } from 'react'

const COLOR_MAP: Record<string, string> = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF',
}

interface StyledSegment {
  text: string
  color?: string
  bold: boolean
  italic: boolean
  underline: boolean
  strikethrough: boolean
}

function parseBeamMP(raw: string): StyledSegment[] {
  const segments: StyledSegment[] = []
  let color: string | undefined
  let bold = false
  let italic = false
  let underline = false
  let strikethrough = false
  let i = 0
  let buf = ''
  while (i < raw.length) {
    const ch = raw[i]
    const next = raw[i + 1]
    if (ch === '^' && next !== undefined) {
      const code = next.toLowerCase()
      if (code in COLOR_MAP || 'rlonm'.includes(code)) {
        if (buf) {
          segments.push({ text: buf, color, bold, italic, underline, strikethrough })
          buf = ''
        }
        if (code in COLOR_MAP) color = COLOR_MAP[code]
        else if (code === 'r') { color = undefined; bold = false; italic = false; underline = false; strikethrough = false }
        else if (code === 'l') bold = true
        else if (code === 'o') italic = true
        else if (code === 'n') underline = true
        else if (code === 'm') strikethrough = true
        i += 2
        continue
      }
    }
    buf += ch ?? ''
    i++
  }
  if (buf) segments.push({ text: buf, color, bold, italic, underline, strikethrough })
  return segments
}

interface BeamMPTextProps {
  text: string
  className?: string
}

export function BeamMPText({ text, className }: BeamMPTextProps): JSX.Element {
  const safe = typeof text === 'string' ? text : ''
  const segments = useMemo(() => parseBeamMP(safe), [safe])
  if (
    segments.length <= 1 &&
    !segments.some((s) => s.color || s.bold || s.italic || s.underline || s.strikethrough)
  ) {
    return <span className={className}>{safe}</span>
  }
  return (
    <span className={className}>
      {segments.map((seg, i) => {
        const style: CSSProperties = {}
        if (seg.color) style.color = seg.color
        if (seg.bold) style.fontWeight = 'bold'
        if (seg.italic) style.fontStyle = 'italic'
        const deco: string[] = []
        if (seg.underline) deco.push('underline')
        if (seg.strikethrough) deco.push('line-through')
        if (deco.length) style.textDecoration = deco.join(' ')
        return (
          <span key={i} style={style}>
            {seg.text as ReactNode}
          </span>
        )
      })}
    </span>
  )
}

/** Strip all `^x` BeamMP formatting codes from a string. Useful for plaintext fallbacks. */
export function stripBeamMP(raw: string): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\^[0-9a-frlonmRLONM]/g, '')
}
