/**
 * DashScope 文本向量（与关键词预排、大模型重排配合）
 * https://help.aliyun.com/zh/model-studio/developer-reference/text-embedding-synchronous-api
 */

import { mainFetch } from './mainFetch'

function embeddingHttpUrl(): string {
  const fromEnv = process.env.DASHSCOPE_EMBEDDING_URL?.trim()
  if (fromEnv) return fromEnv
  return 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding'
}

function embeddingModel(): string {
  const m = process.env.DASHSCOPE_EMBEDDING_MODEL?.trim()
  return m || 'text-embedding-v3'
}

function truncate(s: string, max: number): string {
  const t = s.trim()
  if (t.length <= max) return t
  return t.slice(0, max)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d < 1e-12 ? 0 : dot / d
}

type EmbedApiRow = { embedding?: number[]; text_index?: number }

async function embedOneBatch(options: {
  apiKey: string
  texts: string[]
  textType: 'query' | 'document'
}): Promise<number[][] | null> {
  const { apiKey, texts, textType } = options
  if (texts.length === 0) return []
  const model = embeddingModel()
  const res = await mainFetch(embeddingHttpUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: { texts },
      parameters: { text_type: textType },
    }),
  })
  const raw = await res.text()
  let parsed: {
    output?: { embeddings?: EmbedApiRow[] }
    message?: string
    code?: string
  }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return null
  }
  if (!res.ok) return null
  const rows = parsed.output?.embeddings
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    return null
  }
  const byIndex: (number[] | undefined)[] = new Array(texts.length)
  const sequential: number[][] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const emb = row?.embedding
    if (!Array.isArray(emb) || emb.length === 0) return null
    sequential.push(emb)
    const idx = typeof row?.text_index === 'number' ? row.text_index : i
    if (idx >= 0 && idx < texts.length) byIndex[idx] = emb
  }
  const out: number[][] = []
  for (let i = 0; i < texts.length; i++) {
    const e = byIndex[i] ?? sequential[i]
    if (!e) return null
    out.push(e)
  }
  return out
}

const BATCH = 10
const MAX_CHARS = 1800

/**
 * 先 embed query（检索侧），再分批 embed 每条素材说明（文档侧）。
 * 失败返回 null，调用方回退为仅关键词排序。
 */
export async function embedQueryAndStockDocs(options: {
  apiKey: string
  queryText: string
  docTexts: string[]
}): Promise<{ query: number[]; docs: number[][] } | null> {
  const { apiKey, queryText, docTexts } = options
  const q = truncate(queryText, MAX_CHARS)
  if (!q.trim()) return null

  const queryEmb = await embedOneBatch({
    apiKey,
    texts: [q],
    textType: 'query',
  })
  if (!queryEmb || queryEmb.length !== 1 || !queryEmb[0]?.length) return null
  const queryVec = queryEmb[0]!

  const docs: number[][] = []
  for (let i = 0; i < docTexts.length; i += BATCH) {
    const chunk = docTexts.slice(i, i + BATCH).map((t) => truncate(t || ' ', MAX_CHARS))
    const emb = await embedOneBatch({
      apiKey,
      texts: chunk,
      textType: 'document',
    })
    if (!emb || emb.length !== chunk.length) return null
    docs.push(...emb)
  }

  if (docs.length !== docTexts.length) return null
  return { query: queryVec, docs }
}
