/** Short segments: each piece max N characters (Chinese「字」≈ code unit length). */

/**
 * 本地规则分段上限（汉字）；与云端「短段、多镜感」策略大致对齐。
 * 可在 `.env` 用 `VITE_MAX_CHARS_PER_SEGMENT` 覆盖（仅数字）。
 */
function readMaxCharsFromEnv(): number {
  try {
    const raw = import.meta.env.VITE_MAX_CHARS_PER_SEGMENT as string | undefined
    const n = parseInt(String(raw ?? '').trim(), 10)
    if (Number.isFinite(n) && n >= 24 && n <= 120) return n
  } catch {
    /* ignore */
  }
  return 42
}

export const MAX_CHARS_PER_SEGMENT = readMaxCharsFromEnv()

function readMinSegmentChars(): number {
  try {
    const raw = import.meta.env.VITE_MIN_SEGMENT_CHARS as string | undefined
    const n = parseInt(String(raw ?? '').trim(), 10)
    if (Number.isFinite(n) && n >= 8 && n <= 48) return n
  } catch {
    /* ignore */
  }
  return 18
}

/**
 * 将过短片段并入相邻段（先并前段，首段过短则并到下一段）。
 */
export function mergeShortTextSegments(
  parts: string[],
  minChars: number,
): string[] {
  let segs = parts.map((s) => s.trim()).filter(Boolean)
  let guard = 0
  while (guard++ < 600) {
    const idx = segs.findIndex((s) => s.length < minChars)
    if (idx < 0) break
    if (segs.length <= 1) break
    if (idx > 0) {
      segs[idx - 1] = segs[idx - 1]! + segs[idx]!
      segs.splice(idx, 1)
    } else {
      segs[1] = segs[0]! + segs[1]!
      segs.splice(0, 1)
    }
  }
  return segs
}

/** 句末标点（不因用户换行分段，换行已在 normalize 中抹平） */
const SENTENCE_END = /([。！？!?]|\.\s+)/g

/** Prefer breaking after these within the tail of a chunk (better readability). */
const SOFT_BREAK_CHARS = new Set('，、；：。！？,.!?\n\t \u3000')

export interface StorySegment {
  id: number
  text: string
}

/**
 * 忽略用户输入的版式：换行、多空格、缩进等视为普通空白，
 * 切段仅依据后续标点与语义规则，不因「手工换行」分段。
 */
export function normalizeStoryInputForSegmentation(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\u3000/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** Split into sentence-ish chunks（不按原文换行分段，仅靠句号类标点）。 */
export function splitSentences(text: string): string[] {
  const t = normalizeStoryInputForSegmentation(text)
  if (!t) return []

  const parts = t.split(SENTENCE_END).map((s) => s.trim()).filter(Boolean)

  const sentences: string[] = []
  for (const p of parts) {
    const sub = p.split(/(?<=[。！？；;])\s*/g).map((s) => s.trim()).filter(Boolean)
    for (const s of sub) {
      if (s.length > 0) sentences.push(s)
    }
  }

  if (sentences.length === 0) return t ? [t] : []
  return sentences
}

/**
 * Cut `source` into segments of at most `maxChars` characters.
 * Tries to end on light punctuation in the last ~10 chars to avoid hard mid-phrase cuts.
 */
export function chunkByMaxChars(source: string, maxChars: number): string[] {
  const text = source.trim()
  if (!text) return []
  if (text.length <= maxChars) return [text]

  const out: string[] = []
  let i = 0
  const len = text.length

  while (i < len) {
    const hardEnd = Math.min(i + maxChars, len)
    if (hardEnd >= len) {
      const rest = text.slice(i).trim()
      if (rest) out.push(rest)
      break
    }

    /** 长句仅在末尾 10 字找标点易在中间硬切；放宽到与 maxChars 成比例的一段回溯 */
    const lookback = Math.min(52, Math.max(18, Math.floor(maxChars * 0.42)))
    let end = hardEnd
    for (let j = hardEnd - 1; j > Math.max(i, hardEnd - lookback); j--) {
      const ch = text[j]!
      if (SOFT_BREAK_CHARS.has(ch)) {
        end = j + 1
        break
      }
    }

    if (end <= i) end = hardEnd

    const piece = text.slice(i, end).trim()
    if (piece) out.push(piece)
    i = end
    while (i < len && /\s/.test(text[i]!)) i++
  }

  return out
}

export function segmentStory(raw: string): StorySegment[] {
  const sentences = splitSentences(raw)
  if (sentences.length === 0) return []

  const max = MAX_CHARS_PER_SEGMENT
  const minSeg = readMinSegmentChars()
  const chunks = mergeShortTextSegments(
    sentences.flatMap((s) => chunkByMaxChars(s, max)),
    minSeg,
  )

  return chunks
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text, id) => ({ id, text }))
}
