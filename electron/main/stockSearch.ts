import type { PexelsVideo } from '../../src/types/pexels'
import type { UnifiedStockVideo } from '../../src/types/stockVideo'
import { cosineSimilarity, embedQueryAndStockDocs } from './stockEmbedding'
import { scrapeMixkitVideoListing } from './mixkitScrape'
import { describeFetchError } from './mainFetch'
import { pickPexelsVideoFileNear1080p } from '../../src/lib/pexelsPick'
import { searchPexelsVideos } from './pexels'
import { searchPixabayVideos, type PixabayVideoHit } from './pixabay'

/** 从素材站页面 URL 抽出 slug 词，补充 tags 未覆盖的检索词信息 */
function slugFromStockPageUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
    return last
      .replace(/\.(mp4|webm|jpe?g|png)$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\d{4,}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  } catch {
    return ''
  }
}

function pexelsTagsLine(tags: unknown): string {
  if (!Array.isArray(tags)) return ''
  return tags
    .map((t) =>
      typeof t === 'string' ? t : (t as { title?: string }).title ?? '',
    )
    .filter(Boolean)
    .join(', ')
}

/** 默认 1080p：长边 1920；可用 STOCK_PEXELS_MAX_LONG_EDGE=1440 等覆盖（640～4096） */
function pexelsMaxLongEdgePx(): number {
  const n = parseInt(process.env.STOCK_PEXELS_MAX_LONG_EDGE?.trim() ?? '', 10)
  if (Number.isFinite(n) && n >= 640 && n <= 4096) return n
  return 1920
}

function bestPexelsFileUrl(v: PexelsVideo): string | undefined {
  const f = pickPexelsVideoFileNear1080p(v.video_files, {
    maxLongEdgePx: pexelsMaxLongEdgePx(),
  })
  return f?.link
}

function mapPexels(v: PexelsVideo): UnifiedStockVideo | null {
  const previewVideoUrl = bestPexelsFileUrl(v) ?? ''
  if (!v.image || !previewVideoUrl) return null
  const tags = pexelsTagsLine(v.tags)
  const slug = typeof v.url === 'string' ? slugFromStockPageUrl(v.url) : ''
  const rerankText = [tags, slug, v.user?.name].filter(Boolean).join(' | ')
  return {
    source: 'pexels',
    key: `pexels-${v.id}`,
    pageUrl: v.url,
    duration: v.duration,
    authorName: v.user?.name ?? '—',
    thumbnailUrl: v.image,
    previewVideoUrl,
    rerankText: rerankText || undefined,
  }
}

/** 默认约 1080p：官方 medium 多为 FHD；large 常为 4K。缺档再顺延 small → tiny → large */
function pickPixabayRendition(hit: PixabayVideoHit): {
  videoUrl: string
  thumbUrl: string
} {
  const order = ['medium', 'small', 'tiny', 'large'] as const
  for (const k of order) {
    const o = hit.videos[k]
    /** 部分响应 width 为 0 或缺失，原先 >0 会把所有档位过滤掉 */
    if (o?.url) {
      return {
        videoUrl: o.url,
        thumbUrl: o.thumbnail ?? hit.videos.medium?.thumbnail ?? '',
      }
    }
  }
  const m = hit.videos.medium
  if (m?.url) {
    return { videoUrl: m.url, thumbUrl: m.thumbnail ?? '' }
  }
  return { videoUrl: '', thumbUrl: '' }
}

function mapPixabay(hit: PixabayVideoHit): UnifiedStockVideo | null {
  const { videoUrl, thumbUrl } = pickPixabayRendition(hit)
  if (!videoUrl) return null
  const slug = slugFromStockPageUrl(hit.pageURL)
  const title =
    typeof hit.title === 'string' && hit.title.trim() ? hit.title.trim() : ''
  const rerankText = [hit.tags, title, slug, hit.user].filter(Boolean).join(' | ')
  return {
    source: 'pixabay',
    key: `pixabay-${hit.id}`,
    pageUrl: hit.pageURL,
    duration: hit.duration,
    authorName: hit.user ?? '—',
    thumbnailUrl: thumbUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    previewVideoUrl: videoUrl,
    rerankText: rerankText || undefined,
  }
}

function interleave3<T>(a: T[], b: T[], c: T[]): T[] {
  const out: T[] = []
  const n = Math.max(a.length, b.length, c.length)
  for (let i = 0; i < n; i++) {
    if (i < a.length) out.push(a[i])
    if (i < b.length) out.push(b[i])
    if (i < c.length) out.push(c[i])
  }
  return out
}

export interface StockSearchResult {
  videos: UnifiedStockVideo[]
  warnings: string[]
}

/** 每个素材源单次请求最多拉取的条数（默认 8；可用 STOCK_PER_QUERY_PER_SOURCE 覆盖为 3～12） */
export function stockItemsPerSource(): number {
  const n = parseInt(process.env.STOCK_PER_QUERY_PER_SOURCE ?? '', 10)
  if (Number.isFinite(n)) return Math.min(12, Math.max(3, n))
  return 8
}

/**
 * 并行请求 Pexels、Pixabay 与 Mixkit（可选网页抓取），按条交错合并；任一路失败时写入 warnings。
 * 各站仅取返回列表前 `perSource` 条（站点默认相关度排序）。Mixkit 可通过 MIXKIT_SCRAPE_ENABLED=false 关闭。
 */
export async function searchPexelsAndPixabay(options: {
  pexelsKey?: string
  pixabayKey?: string
  query: string
  perSource?: number
}): Promise<StockSearchResult> {
  const { query, pexelsKey, pixabayKey } = options
  const per = options.perSource ?? stockItemsPerSource()
  const q = query.trim()
  if (!q) return { videos: [], warnings: ['检索词为空'] }

  const mixkitOn = process.env.MIXKIT_SCRAPE_ENABLED !== 'false'
  if (!pexelsKey && !pixabayKey && !mixkitOn) {
    return {
      videos: [],
      warnings: [
        '未配置 PEXELS_API_KEY 与 PIXABAY_API_KEY，且已关闭 Mixkit（MIXKIT_SCRAPE_ENABLED=false）',
      ],
    }
  }

  const warnings: string[] = []
  if (!pexelsKey && !pixabayKey && mixkitOn) {
    warnings.push(
      '未配置 PEXELS / PIXABAY 密钥，当前仅使用 Mixkit 网页抓取（页面改版可能导致失效；请遵守 Mixkit 使用条款）',
    )
  }

  const pex: UnifiedStockVideo[] = []
  const pix: UnifiedStockVideo[] = []
  const mix: UnifiedStockVideo[] = []

  const tasks: Promise<void>[] = []

  if (pexelsKey) {
    tasks.push(
      (async () => {
        try {
          const r = await searchPexelsVideos(pexelsKey, q, per)
          for (const v of r.videos ?? []) {
            const m = mapPexels(v)
            if (m) pex.push(m)
          }
        } catch (e) {
          warnings.push(`Pexels: ${describeFetchError(e)}`)
        }
      })(),
    )
  }

  if (pixabayKey) {
    tasks.push(
      (async () => {
        try {
          const r = await searchPixabayVideos(pixabayKey, q, per)
          for (const h of r.hits ?? []) {
            const m = mapPixabay(h)
            if (m) pix.push(m)
          }
        } catch (e) {
          warnings.push(`Pixabay: ${describeFetchError(e)}`)
        }
      })(),
    )
  }

  if (mixkitOn) {
    tasks.push(
      (async () => {
        try {
          const rows = await scrapeMixkitVideoListing(q, per)
          mix.push(...rows)
          if (rows.length === 0) {
            warnings.push(
              'Mixkit: 未解析到条目（无结果或页面结构已变更）',
            )
          }
        } catch (e) {
          warnings.push(`Mixkit: ${describeFetchError(e)}`)
        }
      })(),
    )
  }

  await Promise.all(tasks)

  const videos = interleave3(pex, pix, mix)
  return { videos, warnings }
}

/** 英文停用词：不参与与检索意图的关键词重合计分 */
const EN_INTENT_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'into',
  'about',
  'over',
  'under',
  'above',
  'below',
  'between',
  'through',
  'around',
  'after',
  'before',
  'while',
  'when',
  'where',
  'what',
  'which',
  'your',
  'their',
  'have',
  'been',
  'being',
  'will',
  'just',
  'more',
  'most',
  'some',
  'such',
  'than',
  'then',
  'very',
  'also',
  'only',
  'even',
  'both',
  'each',
  'other',
  'video',
  'videos',
  'footage',
  'clip',
  'clips',
  'stock',
  'free',
  'background',
  'beautiful',
  'nature',
  'natural',
  'scene',
  'scenes',
  'slow',
  'motion',
  'close',
  'wide',
  'shot',
  'shots',
  'view',
  'views',
  'camera',
  'angle',
  'light',
  'color',
  'hd',
  'k',
  'abstract',
  'cinematic',
  'real',
  'time',
  'day',
  'night',
  'sun',
  'sunset',
  'sunrise',
  'sky',
  'cloud',
  'field',
  'tree',
  'trees',
  'water',
  'ocean',
  'sea',
  'blue',
  'green',
  'black',
  'white',
  'red',
  'golden',
  'hour',
  'aerial',
  'drone',
  'silhouette',
])

function extractEnglishIntentTokens(blob: string): string[] {
  const words = blob.match(/[a-z]{3,}/gi) ?? []
  const out: string[] = []
  const seen = new Set<string>()
  for (const w of words) {
    const lw = w.toLowerCase()
    if (EN_INTENT_STOPWORDS.has(lw)) continue
    if (seen.has(lw)) continue
    seen.add(lw)
    out.push(lw)
  }
  return out
}

function scoreTagsAgainstTokens(
  rerankText: string | undefined,
  tokens: string[],
): number {
  const m = (rerankText ?? '').toLowerCase()
  let score = 0
  for (const t of tokens) {
    if (m.includes(t)) score += t.length >= 6 ? 4 : t.length >= 4 ? 3 : 2
  }
  return score
}

/**
 * 大模型重排前：按「英文镜头句 + 检索词」中的实词与素材 tags 的匹配度预排序，
 * 减少「检索蛇却第一条是蜜蜂」这类仅因合并顺序导致的错位。
 */
export function orderVideosByEnglishKeywordOverlap(
  videos: UnifiedStockVideo[],
  englishParts: string[],
): UnifiedStockVideo[] {
  if (videos.length <= 1) return videos
  const blob = englishParts.map((s) => String(s).trim()).filter(Boolean).join(' ')
  const tokens = extractEnglishIntentTokens(blob)
  if (tokens.length === 0) return videos

  const scored = videos.map((v, origIdx) => ({
    v,
    origIdx,
    score: scoreTagsAgainstTokens(v.rerankText, tokens),
  }))
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.origIdx - b.origIdx
  })
  return scored.map((s) => s.v)
}

function embedKeywordBlend(): number {
  const n = parseFloat(process.env.STOCK_EMBED_KEYWORD_BLEND ?? '')
  if (Number.isFinite(n)) return Math.min(0.95, Math.max(0.2, n))
  return 0.68
}

/**
 * 关键词重合 + 文本向量余弦 + must/avoid 锚定，供大模型重排前的预排序。
 * 无有效 API Key 或关闭向量时，退化为与原先一致的关键词预排（可关 STOCK_ENGLISH_KEYWORD_BOOST）。
 */
export async function hybridReorderStockVideos(
  videos: UnifiedStockVideo[],
  options: {
    apiKey: string
    narrationZh: string
    shotDescriptionEn: string | null
    queries: string[]
    englishParts: string[]
    mustIncludeEn?: string[]
    avoidSubjectsEn?: string[]
  },
): Promise<UnifiedStockVideo[]> {
  const { apiKey, narrationZh, shotDescriptionEn, queries, englishParts } = options
  const must = (options.mustIncludeEn ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 5)
  const avoid = (options.avoidSubjectsEn ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 5)

  if (videos.length <= 1) return videos

  const embedOn = process.env.DASHSCOPE_EMBEDDING_ENABLED !== 'false'
  const kwOn = process.env.STOCK_ENGLISH_KEYWORD_BOOST_ENABLED !== 'false'
  const key = apiKey.trim()

  const blob = englishParts.map((s) => String(s).trim()).filter(Boolean).join(' ')
  const tokens = extractEnglishIntentTokens(blob)
  const kwScores = videos.map((v) => scoreTagsAgainstTokens(v.rerankText, tokens))
  const maxKw = Math.max(...kwScores, 1)
  const blend = embedKeywordBlend()

  const queryText = [
    shotDescriptionEn?.trim(),
    ...queries.map((q) => q.trim()).filter(Boolean),
    narrationZh.trim().slice(0, 160),
  ]
    .filter(Boolean)
    .join(' | ')

  const docTexts = videos.map(
    (v) => v.rerankText?.trim() || `${v.source} ${v.key}`,
  )

  let cosines: number[] | null = null
  if (embedOn && key) {
    try {
      const emb = await embedQueryAndStockDocs({
        apiKey: key,
        queryText,
        docTexts,
      })
      if (emb) {
        cosines = emb.docs.map((d) => cosineSimilarity(emb.query, d))
      }
    } catch (e) {
      console.warn(
        '[stock-embed] DashScope embedding failed, keyword order only:',
        describeFetchError(e),
      )
    }
  }

  const scored = videos.map((v, i) => {
    const cos = cosines ? cosines[i] ?? 0 : 0
    const nk = kwScores[i]! / maxKw

    let combined: number
    if (cosines != null) {
      combined = kwOn ? blend * cos + (1 - blend) * nk : cos
    } else if (kwOn) {
      combined = nk
    } else {
      combined = (videos.length - i) * 1e-6
    }

    const meta = (v.rerankText ?? '').toLowerCase()
    for (const a of avoid) {
      const al = a.toLowerCase()
      if (al.length >= 3 && meta.includes(al)) {
        combined *= 0.32
        break
      }
    }
    let mustAdd = 0
    for (const m of must) {
      const ml = m.toLowerCase()
      if (ml.length >= 2 && meta.includes(ml)) {
        mustAdd += 0.05
      }
    }
    combined += Math.min(mustAdd, 0.15)
    combined = Math.min(combined, 1.6)

    return { v, i, combined }
  })

  scored.sort((a, b) => {
    if (b.combined !== a.combined) return b.combined - a.combined
    return a.i - b.i
  })
  return scored.map((s) => s.v)
}

/**
 * 多条英文检索词并行搜 Pexels / Pixabay / Mixkit，按查询顺序合并并按键去重。
 */
export async function searchMergedDedupe(options: {
  queries: string[]
  pexelsKey?: string
  pixabayKey?: string
  /** 每条检索词在每个素材源的条数（默认 8，范围 3～12） */
  perQueryPerSource?: number
}): Promise<StockSearchResult> {
  const rawQs = options.queries.map((q) => q.trim()).filter(Boolean)
  const seenQ = new Set<string>()
  const queries: string[] = []
  for (const q of rawQs) {
    const k = q.toLowerCase()
    if (seenQ.has(k)) continue
    seenQ.add(k)
    queries.push(q)
  }

  if (queries.length === 0) return { videos: [], warnings: ['检索词为空'] }

  const per = options.perQueryPerSource ?? stockItemsPerSource()

  const results = await Promise.all(
    queries.map((query) =>
      searchPexelsAndPixabay({
        pexelsKey: options.pexelsKey,
        pixabayKey: options.pixabayKey,
        query,
        perSource: per,
      }),
    ),
  )

  const seenKeys = new Set<string>()
  const seenWarn = new Set<string>()
  const videos: UnifiedStockVideo[] = []
  const warnings: string[] = []

  for (const res of results) {
    for (const w of res.warnings) {
      if (seenWarn.has(w)) continue
      seenWarn.add(w)
      warnings.push(w)
    }
    for (const v of res.videos) {
      if (seenKeys.has(v.key)) continue
      seenKeys.add(v.key)
      videos.push(v)
    }
  }

  return { videos, warnings }
}
