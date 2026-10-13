// Every string the graph draws passes through cellText: no control or format
// characters reach the terminal, and widths are counted in terminal cells.

// C0 and C1 controls, DEL, and whole ESC/CSI/OSC sequences.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g
const SPACE = /[\r\n\t]/g
// Bidi controls, zero-width joiners and spaces, the BOM, lone surrogates.
const FORMAT = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const COMBINING = /^[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u0610-\u061a\u064b-\u065f\u0e31\u0e34-\u0e3a\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f]$/

/** Cells one code point takes: 0 for combining marks, 2 for East Asian wide and emoji. */
const pointWidth = (cp: number): number => {
  if (cp < 0x1100) return 1
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

const segmenter: { segment(s: string): Iterable<{ segment: string }> } | undefined =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined

/** The string's graphemes, falling back to code points where Intl.Segmenter is absent. */
export const graphemes = (s: string): string[] => {
  if (segmenter) return Array.from(segmenter.segment(s), g => g.segment)
  const out: string[] = []
  for (const ch of s) {
    if (out.length > 0 && COMBINING.test(ch)) out[out.length - 1] += ch
    else out.push(ch)
  }
  return out
}

/** Cells one grapheme takes: its first code point's width, emoji sequences 2. */
export const graphemeWidth = (g: string): number => {
  const cp = g.codePointAt(0) ?? 0
  if (COMBINING.test(String.fromCodePoint(cp))) return 0
  if (g.length > 2 && /\p{Extended_Pictographic}/u.test(g)) return 2
  return pointWidth(cp)
}

/** Cells the string takes on a terminal. */
export const cellWidth = (s: string): number => {
  let w = 0
  for (const g of graphemes(s)) w += graphemeWidth(g)
  return w
}

/**
 * The string made safe to draw: escape sequences and controls stripped,
 * format characters removed, line breaks and tabs turned to spaces, and cut
 * on a grapheme boundary to at most `maxCells` cells, ending in `…` when cut.
 */
export const cellText = (s: string, maxCells: number): string => {
  const clean = String(s).replace(ANSI, '').replace(SPACE, ' ').replace(CONTROL, '').replace(FORMAT, '')
  if (maxCells <= 0) return ''
  const parts = graphemes(clean)
  let w = 0
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const g = parts[i]!
    const gw = graphemeWidth(g)
    if (w + gw > maxCells) {
      // Leave room for the ellipsis.
      while (out && w + 1 > maxCells) {
        const back = graphemes(out)
        const last = back.pop()!
        w -= graphemeWidth(last)
        out = back.join('')
      }
      return `${out}…`
    }
    out += g
    w += gw
  }
  return out
}
