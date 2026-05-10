/**
 * Alibaba DashScope OpenAI-compatible chat completions.
 * https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api
 */

import { normalizeStoryInputForSegmentation } from '../../src/lib/segment'
import type { UnifiedStockVideo } from '../../src/types/stockVideo'
import type { SegmentVoiceOverResult } from '../../src/types/segment'
import type { VisualStockQueriesResult } from '../../src/types/visualQuery'
import {
  dashscopeChatCompletionsUrl,
  fetchDashscopeChatCompletionJsonWithModelFallback,
  getDashscopeChatModelChain,
  shouldRetryDashscopeChatWithNextModel,
} from './dashscopeModels'
import { mainFetch } from './mainFetch'

/**
 * 兼容模式 Chat Completions 对 `max_tokens` 的允许区间见接口校验（常见为 [1, 16384]）；
 * 超过上限会报 InvalidParameter，与具体模型/地域文档一致。
 */
const DASHSCOPE_COMPAT_MAX_TOKENS = 16384

function normalizeQuery(s: string): string {
  let out = s.replace(/^[\s"'「」]+|[\s"'「」]+$/g, '')
  out = out.split('\n')[0]?.trim() ?? ''
  out = out.replace(/^English[^:]*:\s*/i, '').trim()
  return out.slice(0, 160)
}

function normalizeVisualQueryList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const q of raw) {
    if (typeof q !== 'string') continue
    const n = normalizeQuery(q)
    if (!n) continue
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(n)
    if (out.length >= 4) break
  }
  return out
}

/** must_include / avoid 列表：短英文锚词，去重截断 */
function normalizeSubjectPhraseList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const n = normalizeQuery(x).slice(0, 56)
    if (n.length < 2) continue
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(n)
    if (out.length >= max) break
  }
  return out
}

/** 从模型回复中解析 JSON 对象（允许外层 markdown 代码块） */
function parseJsonObjectFromAssistant(content: string): Record<string, unknown> {
  let t = content.trim()
  if (t.startsWith('```')) {
    t = t
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim()
  }
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  return JSON.parse(t) as Record<string, unknown>
}

/**
 * 画面向英文检索：一句镜头概括 + 2～3 条不同侧重点的 Pexels/Pixabay 检索词。
 */
export async function generateVisualStockQueriesFromChinese(options: {
  apiKey: string
  /** @deprecated 使用环境变量 DASHSCOPE_MODEL_CHAIN / DASHSCOPE_MODEL；传入则仅使用该模型 */
  model?: string
  chineseLine: string
  visualHintEn?: string | null
}): Promise<VisualStockQueriesResult> {
  const { apiKey, chineseLine, visualHintEn } = options
  const trimmed = chineseLine.trim()
  if (!trimmed) throw new Error('文案为空')

  const hint =
    typeof visualHintEn === 'string' && visualHintEn.trim()
      ? visualHintEn.trim()
      : ''

  const system = `You write English search queries for royalty-free stock VIDEO (Pexels, Pixabay, Mixkit).
Rules:
- Think like a cinematographer. Every query MUST contain concrete filmable anchors: WHO/WHAT (subject) + WHERE or WHAT IS HAPPENING (action/scene). Add LIGHTING or CAMERA only when it helps match the line.
- Do NOT output queries that are only abstract mood adjectives without nouns (e.g. avoid standalone "deep sadness" or "inner turmoil").
- If the Chinese line implies night/indoor/winter/sports etc., reflect that in at least one query.
- must_include_en lists entities the footage must clearly show when tags match (literal subjects). avoid_subjects_en lists concrete subjects that would be misleading if they dominate the clip (e.g. wrong animal).
- Output valid JSON only.`

  const user = `Voice-over line (Chinese):
${trimmed}

Optional per-segment shot hint (English, may be empty):
${hint || '(none)'}

Task:
1) shot_description_en: ONE English sentence of what this CUT looks like on screen (concrete: people, objects, place, action). If the Chinese is abstract, still invent a filmable shot.
2) queries: exactly 2 or 3 DISTINCT English search strings (5–14 words each). Each query must use a different angle, e.g. (A) subject + close action, (B) environment/wide context, (C) lighting/mood/camera—while staying faithful to the Chinese line.
Hard rule: each query must include at least two content words that could appear in real stock tags (nouns, verbs, place words).
3) must_include_en: array of 1–4 English keywords or short noun phrases that stock tags SHOULD literally reflect for this shot (e.g. snake, basketball court). Use [] only if the line is purely abstract with no concrete anchor.
4) avoid_subjects_en: array of 0–4 English keywords for subjects that would be WRONG if they are the main focus when the Chinese line is clearly about something else (e.g. if the line is about snakes, include bee, honeybee). Use [] if none.

Reply with ONLY this JSON shape (no markdown outside JSON):
{"shot_description_en":"...","queries":["...","..."],"must_include_en":["..."],"avoid_subjects_en":[]}`

  const { json: parsed } =
    await fetchDashscopeChatCompletionJsonWithModelFallback(
      apiKey,
      (model) => ({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.28,
        max_tokens: 640,
      }),
      options.model ?? null,
    )
  const json = parsed as {
    error?: { message?: string }
    choices?: { message?: { content?: string } }[]
  }

  const text = json.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('DashScope 返回空内容')

  let obj: Record<string, unknown>
  try {
    obj = parseJsonObjectFromAssistant(text)
  } catch {
    throw new Error(`无法解析检索 JSON：${text.slice(0, 400)}`)
  }

  let queries = normalizeVisualQueryList(obj.queries)
  if (queries.length < 2) {
    const single = typeof obj.query === 'string' ? normalizeQuery(obj.query) : ''
    if (single && !queries.includes(single)) queries.push(single)
  }
  if (queries.length < 2) {
    const fallback =
      typeof obj.shot_description_en === 'string'
        ? normalizeQuery(obj.shot_description_en)
        : ''
    if (fallback && !queries.includes(fallback)) queries.unshift(fallback)
  }
  queries = normalizeVisualQueryList(queries)
  if (queries.length === 0) throw new Error('模型未返回有效检索词')

  const shotRaw = obj.shot_description_en
  const shotDescriptionEn =
    typeof shotRaw === 'string' && shotRaw.trim()
      ? normalizeQuery(shotRaw).slice(0, 400)
      : queries[0] ?? ''

  const mustIncludeEn = normalizeSubjectPhraseList(obj.must_include_en, 4)
  const avoidSubjectsEn = normalizeSubjectPhraseList(obj.avoid_subjects_en, 4)

  return { shotDescriptionEn, queries, mustIncludeEn, avoidSubjectsEn }
}

function rerankCandidatePoolSize(): number {
  const n = parseInt(process.env.DASHSCOPE_RERANK_POOL ?? '', 10)
  if (Number.isFinite(n)) return Math.min(40, Math.max(12, n))
  return 28
}

/**
 * 用语义模型根据口播句对候选素材做二次排序（基于每条 rerankText）。
 * englishShotDescription / englishQueries 用于锚定画面主体，避免文不对题。
 */
export async function rerankStockVideosByNarration(options: {
  apiKey: string
  /** @deprecated 使用 DASHSCOPE_MODEL_CHAIN；传入则仅该模型 */
  model?: string
  narrationZh: string
  candidates: UnifiedStockVideo[]
  englishShotDescription?: string | null
  englishQueries?: string[]
  mustIncludeEn?: string[]
  avoidSubjectsEn?: string[]
}): Promise<UnifiedStockVideo[]> {
  const {
    apiKey,
    narrationZh,
    englishShotDescription,
    englishQueries,
    mustIncludeEn,
    avoidSubjectsEn,
  } = options
  const candidates = options.candidates
  if (candidates.length <= 1) return candidates

  const pool = rerankCandidatePoolSize()
  const head = candidates.slice(0, pool)
  const tail = candidates.slice(pool)

  const lines = head.map((v, i) => {
    const meta =
      v.rerankText?.trim() ||
      [v.source, v.authorName].filter(Boolean).join(' · ')
    return `${i + 1}. [${v.source}] ${meta}`
  })

  const enShot =
    typeof englishShotDescription === 'string' && englishShotDescription.trim()
      ? englishShotDescription.trim()
      : ''
  const enQs =
    Array.isArray(englishQueries) && englishQueries.length > 0
      ? englishQueries.map((q) => String(q).trim()).filter(Boolean)
      : []
  const must =
    Array.isArray(mustIncludeEn) && mustIncludeEn.length > 0
      ? mustIncludeEn.map((s) => String(s).trim()).filter(Boolean)
      : []
  const avoid =
    Array.isArray(avoidSubjectsEn) && avoidSubjectsEn.length > 0
      ? avoidSubjectsEn.map((s) => String(s).trim()).filter(Boolean)
      : []
  const englishIntentBlock =
    enShot ||
    enQs.length > 0 ||
    must.length > 0 ||
    avoid.length > 0
      ? `本镜英文画面意图（检索与排序必须与下列主体一致；若下列明确出现动物/物体名，则展示无关物种或无关主体的素材必须垫底）：
${enShot ? `- 镜头概括（英）：${enShot}` : ''}
${enQs.length > 0 ? `- 英文检索词：${enQs.join(' | ')}` : ''}
${must.length > 0 ? `- 标签应明显体现的英文锚词（优先靠前）：${must.join(' | ')}` : ''}
${avoid.length > 0 ? `- 易混淆、若占据画面主体则应明显靠后的英文实体：${avoid.join(' | ')}` : ''}

`
      : ''

  const user = `${englishIntentBlock}口播文案（中文）：
${narrationZh.trim()}

候选素材（共 ${head.length} 条，序号 1～${head.length}），每条有一段英文标签/说明：
${lines.join('\n')}

排序原则（按优先级）：
1) 画面**主体**是否与上述英文意图及中文口播一致（例如口播/检索为蛇时，蜜蜂、花卉特写等与蛇无关的素材必须排在末位）。
2) **主体一致**前提下，再看场景、动作、情绪与光影。
3) 标签过于泛泛、与叙事主体明显无关的「好看空镜」往后排。

请将上述 ${head.length} 条素材**全部**按与「这一镜口播」的贴合度**从高到低**排序。
仅输出 JSON：{"order":[a,b,c,...]}：order 长度须为 ${head.length}，且为 1～${head.length} 的一个**无重复排列**。
含义：第 1 个数字表示最相关素材的序号，依此类推。不要其它文字。`

  let parsed: {
    error?: { message?: string }
    choices?: { message?: { content?: string } }[]
  }
  try {
    const { json } = await fetchDashscopeChatCompletionJsonWithModelFallback(
      apiKey,
      (model) => ({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You rank stock video clips. CRITICAL: If the user specifies English visual intent (shot description or search queries naming a subject such as an animal or object), clips whose tags clearly depict unrelated subjects (different animal, unrelated macro nature without that subject) MUST be ranked LAST. Prefer clips whose tags literally match the named subject. Output valid JSON only.',
          },
          { role: 'user', content: user },
        ],
        temperature: 0.15,
        max_tokens: 1024,
      }),
      options.model ?? null,
    )
    parsed = json as typeof parsed
  } catch {
    return candidates
  }

  const content = parsed.choices?.[0]?.message?.content?.trim()
  if (!content) return candidates

  let obj: Record<string, unknown>
  try {
    obj = parseJsonObjectFromAssistant(content)
  } catch {
    return candidates
  }

  const orderRaw = obj.order ?? obj.ranked ?? obj.top_indices ?? obj.indices
  if (!Array.isArray(orderRaw)) return candidates

  const orderOneBased = orderRaw
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x))

  const rerankedHead = applyFullPermutationOrder(head, orderOneBased)
  return [...rerankedHead, ...tail]
}

/** 按模型给出的 1-based 全序重排；缺失序号则按原顺序补尾 */
function applyFullPermutationOrder<T>(
  items: T[],
  orderOneBased: number[],
): T[] {
  const n = items.length
  const used = new Set<number>()
  const out: T[] = []
  for (const r of orderOneBased) {
    const idx = Math.floor(Number(r)) - 1
    if (!Number.isFinite(idx) || idx < 0 || idx >= n || used.has(idx)) continue
    used.add(idx)
    out.push(items[idx])
  }
  for (let i = 0; i < n; i++) {
    if (!used.has(i)) out.push(items[i])
  }
  return out
}

function minModelSegmentChars(): number {
  const n = parseInt(process.env.DASHSCOPE_MIN_SEGMENT_CHARS ?? '18', 10)
  if (Number.isFinite(n)) return Math.min(48, Math.max(8, n))
  return 18
}

/** 将模型返回的过短段并入邻段，并同步合并 visual_hints_en */
function mergeShortSegmentsFromModel(
  segments: string[],
  visualHintsEn: (string | null)[],
  minChars: number,
): { segments: string[]; visualHintsEn: (string | null)[] } {
  let segs = segments.map((s) => s.trim()).filter(Boolean)
  let hints = [...visualHintsEn]
  while (hints.length < segs.length) hints.push(null)
  hints = hints.slice(0, segs.length)

  let guard = 0
  while (guard++ < 600) {
    const idx = segs.findIndex((s) => s.length < minChars)
    if (idx < 0) break
    if (segs.length <= 1) break
    if (idx > 0) {
      const ha = hints[idx - 1]
      const hb = hints[idx]
      hints[idx - 1] = ha && hb ? `${ha} / ${hb}` : ha ?? hb ?? null
      segs[idx - 1] = segs[idx - 1]! + segs[idx]!
      segs.splice(idx, 1)
      hints.splice(idx, 1)
    } else {
      const ha = hints[0]
      const hb = hints[1]
      hints[1] = ha && hb ? `${ha} / ${hb}` : hb ?? ha ?? null
      segs[1] = segs[0]! + segs[1]!
      segs.splice(0, 1)
      hints.splice(0, 1)
    }
  }

  return { segments: segs, visualHintsEn: hints }
}

/** 句末是否已在句号、问号、叹号等处闭合（用于合并模型误切的「半句话」） */
function appearsSentenceCompleteForMerge(s: string): boolean {
  const t = s.trimEnd()
  if (!t) return true
  if (/…+[」』）\s]*$/.test(t)) return true
  return /[。！？!?][」』）\s]*$/.test(t)
}

function mergeIncompleteMaxCombinedChars(): number {
  const n = parseInt(process.env.DASHSCOPE_MERGE_INCOMPLETE_MAX_CHARS ?? '', 10)
  if (Number.isFinite(n)) return Math.min(140, Math.max(56, n))
  /** 默认略收紧：减少「半句硬并」带来的超长段 */
  return 72
}

/**
 * 若上一段不以句末标点结束，且两段拼接长度在上限内，则合并为一段（缓解模型在逗号处过度切开）。
 */
function mergeAdjacentIncompleteSentenceSplits(
  segments: string[],
  visualHintsEn: (string | null)[],
  maxCombinedChars: number,
): { segments: string[]; visualHintsEn: (string | null)[] } {
  let segs = segments.map((s) => s.trim()).filter(Boolean)
  let hints = [...visualHintsEn]
  while (hints.length < segs.length) hints.push(null)
  hints = hints.slice(0, segs.length)

  let guard = 0
  while (guard++ < segs.length + 12) {
    let did = false
    for (let i = 0; i < segs.length - 1; i++) {
      const a = segs[i]!
      const b = segs[i + 1]!
      if (appearsSentenceCompleteForMerge(a)) continue
      const combinedLen = a.length + b.length
      if (combinedLen > maxCombinedChars) continue
      const ha = hints[i]
      const hb = hints[i + 1]
      hints[i] = ha && hb ? `${ha} / ${hb}` : ha ?? hb ?? null
      segs[i] = a + b
      segs.splice(i + 1, 1)
      hints.splice(i + 1, 1)
      did = true
      break
    }
    if (!did) break
  }

  return { segments: segs, visualHintsEn: hints }
}

/** 单段超过该字数则按标点再切（模型偶发超长段）；可用 DASHSCOPE_HARD_CAP_SEGMENT_CHARS 覆盖 */
function hardCapSegmentChars(): number {
  const n = parseInt(process.env.DASHSCOPE_HARD_CAP_SEGMENT_CHARS ?? '', 10)
  if (Number.isFinite(n)) return Math.min(56, Math.max(26, n))
  return 38
}

function cutFirstChunkPreferPunct(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  const reach = Math.min(s.length, maxLen + Math.ceil(maxLen * 0.35))
  const slice = s.slice(0, reach)
  const lo = Math.max(1, Math.floor(maxLen * 0.42))
  for (let i = slice.length - 1; i >= lo; i--) {
    const c = slice[i]!
    if ('。！？!?…'.includes(c)) return slice.slice(0, i + 1)
  }
  for (let i = Math.min(slice.length - 1, maxLen); i >= lo; i--) {
    const c = slice[i]!
    if ('，、；,.;'.includes(c)) return slice.slice(0, i + 1)
  }
  return s.slice(0, maxLen)
}

/**
 * 将仍超过上限的段切开（不改变全文拼接），再交给 mergeShort 吸收过短段。
 */
function splitLongSegmentsAfterMerge(
  segments: string[],
  visualHintsEn: (string | null)[],
  maxChars: number,
): { segments: string[]; visualHintsEn: (string | null)[] } {
  const outS: string[] = []
  const outH: (string | null)[] = []
  for (let i = 0; i < segments.length; i++) {
    let rest = segments[i]!.trim()
    if (!rest) continue
    const h = i < visualHintsEn.length ? visualHintsEn[i]! : null
    while (rest.length > maxChars) {
      const chunk = cutFirstChunkPreferPunct(rest, maxChars)
      const piece = chunk.length > 0 ? chunk : rest.slice(0, maxChars)
      outS.push(piece)
      outH.push(h)
      rest = rest.slice(piece.length).trimStart()
    }
    if (rest.length) {
      outS.push(rest)
      outH.push(h)
    }
  }
  return { segments: outS, visualHintsEn: outH }
}

/**
 * 分段接口返回值重复包含全文 JSON + 英文 hints，输出 token 需求通常接近「正文长度」量级；
 * 仅用固定 8192 容易截断导致 JSON 不完整。
 */
function segmentOutputMaxTokens(textLen: number, envFloor: number): number {
  const cap = DASHSCOPE_COMPAT_MAX_TOKENS
  const floor = Math.min(cap, Math.max(512, Math.min(envFloor, cap)))
  const scaled = Math.ceil(textLen * 2.85) + 10240
  return Math.min(cap, Math.max(floor, scaled))
}

/** 单批正文最大字符数；超长则拆多次调用，避免输入/输出顶满上下文 */
function segmentChunkMaxChars(): number {
  const n = parseInt(process.env.DASHSCOPE_SEGMENT_CHUNK_CHARS ?? '', 10)
  if (Number.isFinite(n)) return Math.min(6000, Math.max(1500, n))
  return 3200
}

const SEGMENT_BATCH_CONTEXT_TAIL = 120

/**
 * 在句号、问号等首选切点分批；过长无标点时在逗号处截断；仍无则硬截断，避免死循环。
 */
function splitTextForSegmentBatches(
  text: string,
  maxChunk: number,
): string[] {
  const t = text.trim()
  if (!t) return []
  if (t.length <= maxChunk) return [t]
  const chunks: string[] = []
  let start = 0
  const searchWindow = 480
  while (start < t.length) {
    const remaining = t.length - start
    if (remaining <= maxChunk) {
      chunks.push(t.slice(start))
      break
    }
    const slice = t.slice(start, start + maxChunk)
    let cutRel = -1
    const lo = Math.max(0, slice.length - searchWindow)
    for (let i = slice.length - 1; i >= lo; i--) {
      const c = slice[i]!
      if ('。！？!?'.includes(c)) {
        cutRel = i + 1
        break
      }
    }
    if (cutRel < 0) {
      for (let i = slice.length - 1; i >= lo; i--) {
        const c = slice[i]!
        if ('，、；,.;'.includes(c)) {
          cutRel = i + 1
          break
        }
      }
    }
    if (cutRel <= 0) cutRel = slice.length
    chunks.push(t.slice(start, start + cutRel))
    start += cutRel
  }
  return chunks
}

const SEGMENT_RULES_BLOCK = `切分要求（必须严格遵守）：
0. **版式无关**：不要根据用户原文里的换行、空行、手工分段、缩进来决定在哪里切段；只根据**语义、语气停顿、口播换气节奏**以及短小镜头单元来切。**仅在**话题或叙事层面出现明显大段落转折时，可优先在此处切段。
1. **整句优先（最重要）**：以「。」「！」「？」收尾的**完整句子默认留在同一段**，不要为了凑「短段」而在**句中**切断。**只有**当**单独一句**内部已超过约 **48 个汉字**时，才允许在该句内的逗号、顿号等停顿处拆成两段；不足 48 字的整句必须保持完整。
2. **短段与一镜一意**：在遵守「整句优先」的前提下，单段宜 **约 14～36 个汉字**（常见 **1 句或极短的两句**）。同一场景连续叙述若整体超过约 **38 字**，优先在**句号处**拆段；若仅为逗号间隔且整句不长，不要拆开。
3. **该切就切**：时间、空间、人物焦点、情绪或话题**明显变化**时**必须**新起一段；不要把多个彼此独立的画面硬塞进同一段。
4. 每一段是一条自然的朗读单位：换气顺畅、语气完整；不要在词中间切断。
5. 优先在**句号、问号、叹号**后断开；其次才是分号、逗号（逗号处拆开须满足上面的长度与整句规则）。避免拆开固定搭配、人名、数字与单位。
6. **保留原文用字**：不要改写、不要摘要、不要润色，只做切分；**segments 按顺序拼接必须与本批「正文」字符级一致**（片段内部可使用单个空格代替用户原先任意空白）。
7. **禁止「几个字」的孤立小段**：**禁止**出现仅靠逗号、语气词或碎片短语单独成段（例如少于约 **16 个汉字/字符**的一小段）。此类必须并入**相邻段**，使每一段至少能构成一口气读完的短句或小意群；仅允许在**本批**收尾处略短，但仍应避免单独一两个词的段。

同时给出 visual_hints_en 数组，与 segments **等长**。每一项用英文写「这一镜大概在拍什么」（单一镜头或场景），用于检索免费视频素材；若该段偏抽象可写概括性画面；无关则写 ""。
**实体一致**：若中文稿点名具体动物、器物、地点或人物身份，对应的英文提示应指向同一可拍实体；除非该段是明确的修辞或隐喻镜头，否则不要用指向完全不同具体物体的英文画面，以免检索到与叙事无关的素材。

输出格式：仅输出一个 JSON 对象，不要有其它说明文字：
{"segments":["第一段原文","第二段原文",...],"visual_hints_en":["English shot hint or empty string", ...]}`

function buildSegmentPromptSingle(fullText: string): string {
  return `你是中文播读与配音导演助理，同时为短视频/纪录片配画面。下面是一篇完整的故事/解说稿（已去掉用户输入时的多余换行与缩进，**请勿依据原文排版来切段**），请你切成适合「口播朗读」且**每一段对应相对单一的画面节奏**的片段（便于换镜头、配素材）。

${SEGMENT_RULES_BLOCK}

全文如下：
${fullText}`
}

function buildSegmentPromptBatch(options: {
  chunkText: string
  partIndex: number
  partTotal: number
  prevTail: string | null
}): string {
  const { chunkText, partIndex, partTotal, prevTail } = options
  const batchNote =
    partTotal > 1
      ? `【分批说明】整篇稿件已按长度拆成 ${partTotal} 批；当前为**第 ${partIndex + 1} / ${partTotal} 批**。你**只能**对本批「正文」中的汉字切段；**segments 依次拼接后必须与本批正文完全一致**（字符级），不得写入其它批次的内容。`
      : ''
  const ctx =
    prevTail && prevTail.length > 0
      ? `\n【衔接参考】上一批结尾文字（仅供语气衔接，**不要**写入 segments）：\n${prevTail}\n`
      : ''
  return `你是中文播读与配音导演助理，同时为短视频/纪录片配画面。

${batchNote}
${SEGMENT_RULES_BLOCK}
${ctx}
本批正文如下：
${chunkText}`
}

function rawSegmentsFromAssistantJson(obj: Record<string, unknown>): {
  segments: string[]
  visualHintsEn: (string | null)[]
} {
  const seg = obj.segments
  if (!Array.isArray(seg)) {
    throw new Error('模型返回 JSON 中缺少 segments 数组')
  }

  const out = seg
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean)

  if (out.length === 0) throw new Error('segments 为空')

  const hintsRaw = obj.visual_hints_en
  let visualHintsEn: (string | null)[] = []
  if (Array.isArray(hintsRaw)) {
    visualHintsEn = hintsRaw.map((x) => {
      if (typeof x !== 'string') return null
      const t = x.trim()
      return t.length ? t : null
    })
  }
  while (visualHintsEn.length < out.length) {
    visualHintsEn.push(null)
  }
  if (visualHintsEn.length > out.length) {
    visualHintsEn = visualHintsEn.slice(0, out.length)
  }
  return { segments: out, visualHintsEn }
}

async function invokeSegmentCompletion(options: {
  apiKey: string
  userPrompt: string
  chunkCharLen: number
  maxOutFloor: number
  batchLabel: string
  explicitModel?: string | null
}): Promise<Record<string, unknown>> {
  const { apiKey, userPrompt, chunkCharLen, maxOutFloor, batchLabel } = options

  const primaryMax = segmentOutputMaxTokens(chunkCharLen, maxOutFloor)
  const retryMax = DASHSCOPE_COMPAT_MAX_TOKENS
  const tokenAttempts =
    primaryMax < retryMax ? [primaryMax, retryMax] : [primaryMax]

  const models = getDashscopeChatModelChain(options.explicitModel ?? null)

  let obj: Record<string, unknown> | undefined
  let lastContent = ''
  let lastErr: Error | null = null

  modelLoop: for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi]!

    for (let ti = 0; ti < tokenAttempts.length; ti++) {
      const maxTok = tokenAttempts[ti]!
      const res = await mainFetch(dashscopeChatCompletionsUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                'You follow instructions exactly. Output valid JSON only in the user-requested shape.',
            },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: Math.min(
            Math.max(512, maxTok),
            DASHSCOPE_COMPAT_MAX_TOKENS,
          ),
        }),
      })

      const raw = await res.text()
      let parsed: {
        error?: { message?: string }
        choices?: { message?: { content?: string } }[]
      }
      try {
        parsed = JSON.parse(raw) as typeof parsed
      } catch {
        const msg = `DashScope 非 JSON 响应 (${res.status}): ${raw.slice(0, 500)}`
        if (
          mi < models.length - 1 &&
          shouldRetryDashscopeChatWithNextModel(res.status, raw)
        ) {
          console.warn(
            `[dashscope] segment "${batchLabel}" non-JSON (${res.status}), trying next model…`,
          )
          lastErr = new Error(msg)
          continue modelLoop
        }
        throw new Error(msg)
      }

      if (!res.ok) {
        const msg =
          parsed.error?.message ??
          `DashScope HTTP ${res.status}: ${raw.slice(0, 500)}`
        if (
          mi < models.length - 1 &&
          shouldRetryDashscopeChatWithNextModel(res.status, raw)
        ) {
          console.warn(
            `[dashscope] segment "${batchLabel}" model "${model}" (${res.status}): ${msg.slice(0, 140)} → next model`,
          )
          lastErr = new Error(msg)
          continue modelLoop
        }
        throw new Error(msg)
      }

      const content = parsed.choices?.[0]?.message?.content?.trim()
      if (!content) {
        const msg = 'DashScope 分段返回空内容'
        lastErr = new Error(msg)
        if (mi < models.length - 1) {
          console.warn(
            `[dashscope] segment "${batchLabel}" empty assistant message → next model`,
          )
          continue modelLoop
        }
        throw lastErr
      }
      lastContent = content

      try {
        obj = parseJsonObjectFromAssistant(content)
        return obj
      } catch {
        const truncatedHint =
          content.length > 16000
            ? `输出过长可能被截断（约 ${content.length} 字符）。`
            : ''
        if (ti === tokenAttempts.length - 1) {
          throw new Error(
            `无法解析分段 JSON（${batchLabel}）。${truncatedHint}可在 .env 调整 DASHSCOPE_SEGMENT_MAX_TOKENS / DASHSCOPE_SEGMENT_CHUNK_CHARS（输出上限 ${DASHSCOPE_COMPAT_MAX_TOKENS}；当前 max_tokens=${maxTok}）。片段预览：${content.slice(0, 520)}`,
          )
        }
      }
    }
  }

  if (!obj) {
    throw (
      lastErr ??
      new Error(`无法解析分段 JSON（${batchLabel}）：${lastContent.slice(0, 400)}`)
    )
  }
  return obj
}

/**
 * 使用阿里云大模型将全文切分为适合配音口播的片段；可选返回每段英文画面提示 visual_hints_en。
 * 超长正文按 `DASHSCOPE_SEGMENT_CHUNK_CHARS` 拆批多次调用，再顺序拼接结果。
 */
export async function segmentForVoiceOver(options: {
  apiKey: string
  /** @deprecated 使用 DASHSCOPE_MODEL_CHAIN；传入则固定单模型 */
  model?: string
  fullText: string
  maxOutputTokens?: number
}): Promise<SegmentVoiceOverResult> {
  const { apiKey, fullText } = options
  const trimmed = normalizeStoryInputForSegmentation(fullText)
  if (!trimmed) throw new Error('全文为空')

  let maxOut = options.maxOutputTokens
  if (maxOut == null) {
    const n = parseInt(process.env.DASHSCOPE_SEGMENT_MAX_TOKENS ?? '', 10)
    maxOut = Number.isFinite(n) ? n : 8192
  }

  const chunkCap = segmentChunkMaxChars()
  const batches = splitTextForSegmentBatches(trimmed, chunkCap)

  if (batches.length > 1) {
    console.info(
      `[dashscope] segmentForVoiceOver: ${batches.length} batches (≤${chunkCap} chars each)`,
    )
  }

  const allSeg: string[] = []
  const allHints: (string | null)[] = []

  for (let bi = 0; bi < batches.length; bi++) {
    const chunk = batches[bi]!
    const prevTail =
      bi > 0
        ? batches[bi - 1]!.slice(
            -Math.min(SEGMENT_BATCH_CONTEXT_TAIL, batches[bi - 1]!.length),
          )
        : null
    const userPrompt =
      batches.length === 1
        ? buildSegmentPromptSingle(chunk)
        : buildSegmentPromptBatch({
            chunkText: chunk,
            partIndex: bi,
            partTotal: batches.length,
            prevTail,
          })

    const obj = await invokeSegmentCompletion({
      apiKey,
      userPrompt,
      chunkCharLen: chunk.length,
      maxOutFloor: maxOut,
      batchLabel:
        batches.length === 1
          ? 'single'
          : `batch ${bi + 1}/${batches.length}`,
      explicitModel: options.model ?? null,
    })

    const parsed = rawSegmentsFromAssistantJson(obj)
    const joined = parsed.segments.join('')
    if (joined !== chunk) {
      console.warn(
        `[dashscope] batch ${bi + 1}: segment concat length mismatch (got ${joined.length}, expect ${chunk.length})`,
      )
    }

    allSeg.push(...parsed.segments)
    allHints.push(...parsed.visualHintsEn)
  }

  const concatAll = allSeg.join('')
  if (concatAll !== trimmed) {
    console.warn(
      `[dashscope] full segment concat mismatch (got ${concatAll.length}, expect ${trimmed.length})`,
    )
  }

  const minChars = minModelSegmentChars()
  let mergedShort = mergeShortSegmentsFromModel(allSeg, allHints, minChars)
  const maxComb = mergeIncompleteMaxCombinedChars()
  const mergedJoin = mergeAdjacentIncompleteSentenceSplits(
    mergedShort.segments,
    mergedShort.visualHintsEn,
    maxComb,
  )
  mergedShort = mergeShortSegmentsFromModel(
    mergedJoin.segments,
    mergedJoin.visualHintsEn,
    minChars,
  )
  const capped = splitLongSegmentsAfterMerge(
    mergedShort.segments,
    mergedShort.visualHintsEn,
    hardCapSegmentChars(),
  )
  mergedShort = mergeShortSegmentsFromModel(
    capped.segments,
    capped.visualHintsEn,
    minChars,
  )
  return {
    segments: mergedShort.segments,
    visualHintsEn: mergedShort.visualHintsEn,
  }
}

/**
 * 将分段上下文压成一段高质量文生视频提示词（即梦 / 火山视觉），强化主体、镜头与负向约束。
 * 需配合 `heuristicDraft`（结构化草稿）使用；失败时由调用方回退到草稿。
 */
export async function refinePromptForJimengVideo(options: {
  apiKey: string
  /** @deprecated 使用 DASHSCOPE_MODEL_CHAIN */
  model?: string
  narrationZh: string
  shotDescriptionEn?: string | null
  visualHintEn?: string | null
  mustIncludeEn?: string[]
  avoidSubjectsEn?: string[]
  stockQueriesEn?: string[]
  heuristicDraft: string
}): Promise<string> {
  const {
    apiKey,
    narrationZh,
    shotDescriptionEn,
    visualHintEn,
    mustIncludeEn = [],
    avoidSubjectsEn = [],
    stockQueriesEn = [],
    heuristicDraft,
  } = options

  const system = `You rewrite prompts for Jimeng / Volcengine text-to-video (photoreal, cinematic).
Goal: MAXIMUM semantic alignment between the generated clip and the Chinese narration (narration_zh). Visuals must illustrate what the narration says, not a generic mood piece.

Output format (exact section labels in Chinese brackets, then content — this improves model compliance):
1) Line starting with 【中文剧情锚点】 — one sentence: what concrete situation the narration describes (facts + emotion), ≤120 Chinese characters.
2) Line starting with 【英文镜头描述】 — one rich English paragraph: WHO/WHAT, WHERE, ACTION, time of day/lighting, camera (shot size + movement). Embed must_include_en items as visible subjects/props. Use shot_description_en and stock_queries_en; do not contradict narration_zh.
3) If avoid_subjects_en non-empty: line 【避免】 — English comma-separated wrong subjects to keep out of focus.
4) Line 【风格】 — short English: realistic footage, no on-screen text/logos/watermarks.

Rules: No markdown code fences; no JSON; no meta commentary. Total under 1800 characters. Temperature discipline: prefer literal illustration over abstract metaphors unless narration is purely abstract.`

  const ctx = {
    narration_zh: narrationZh.trim(),
    shot_description_en: shotDescriptionEn?.trim() ?? '',
    visual_hint_en: visualHintEn?.trim() ?? '',
    must_include_en: mustIncludeEn,
    avoid_subjects_en: avoidSubjectsEn,
    stock_queries_en: stockQueriesEn,
    structured_draft: heuristicDraft.slice(0, 2600),
  }

  const user = `Rewrite into the final prompt. The draft below encodes our retrieval constraints — keep must/avoid/story facts, tighten camera and setting so the clip cannot be off-topic.

${JSON.stringify(ctx)}`

  const { json: parsed } =
    await fetchDashscopeChatCompletionJsonWithModelFallback(
      apiKey,
      (model) => ({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.22,
        max_tokens: 1200,
      }),
      options.model ?? null,
    )
  const json = parsed as {
    error?: { message?: string }
    choices?: { message?: { content?: string } }[]
  }

  let text = json.choices?.[0]?.message?.content?.trim() ?? ''
  if (!text) throw new Error('DashScope 返回空提示词')
  if (text.startsWith('```')) {
    text = text
      .replace(/^```(?:\w+)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim()
  }
  return text
}
