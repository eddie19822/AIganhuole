/**
 * 即梦 AI 视频：火山「视觉智能」OpenAPI（与官方文档一致）
 * - 提交：CVSync2AsyncSubmitTask，查询：CVSync2AsyncGetResult
 * - 文生视频 Pro：req_key `jimeng_ti2v_v30_pro`（见 volcengine.com/docs/85621/1777001）
 * - 鉴权：IAM AccessKey + SecretKey（@volcengine/openapi Signer）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { Signer } from '@volcengine/openapi'
import type { RequestObj } from '@volcengine/openapi/lib/base/types'
import type { JimengProgressPayload } from '../../src/types/jimengVideo'
import type { UnifiedStockVideo } from '../../src/types/stockVideo'
import { refinePromptForJimengVideo } from './dashscope'
import { synthesizeDoubaoTtsMp3Base64 } from './doubaoTts'
import { effectiveDashscopeApiKey, effectiveVolcIam } from './userApiKeys'
import { mainFetch } from './mainFetch'

const require = createRequire(import.meta.url)

const VISUAL_HOST =
  process.env.JIMENG_VISUAL_HOST?.trim() || 'https://visual.volcengineapi.com'
const VISUAL_VERSION = '2022-08-31'
const VISUAL_REGION = process.env.JIMENG_VISUAL_REGION?.trim() || 'cn-north-1'
/**
 * 视觉 IAM 默认 req_key 链（文档 85621 / 控制台实际开通能力为准）。
 * 仅内置即梦 3.0 文生视频已知 req_key；勿臆造 Seedance/小云雀 key（否则会 VisualAPI 50200 not supported）。
 * 若另有 Seedance 等能力，请在环境变量 JIMENG_VISUAL_REQ_KEY_CHAIN 中按控制台提供的字符串前置追加。
 */
const DEFAULT_VISUAL_REQ_KEY_CHAIN_CSV =
  'jimeng_t2v_v30,jimeng_t2v_v30_1080p,jimeng_ti2v_v30_pro'

/** 本机缓存成片文件名前缀，需与主进程 jimeng-local 协议校验一致 */
export const JIMENG_PREVIEW_FILENAME_PREFIX = 'story-stock-jimeng-preview-'

function toJimengLocalPreviewUrl(absPath: string): string {
  const t = Buffer.from(absPath, 'utf8').toString('base64url')
  return `jimeng-local://preview?t=${t}`
}

/**
 * 将即梦返回的远程 URL 拉取到系统临时目录，用 jimeng-local 协议在页面内播放（避免 CDN/Range/跨域导致黑屏）。
 * 失败时回退为原始 https，由界面再尝试 story-video 代拉。
 */
async function mirrorJimengVideoForPreview(
  remoteUrl: string,
  onProgress?: (p: JimengProgressPayload) => void,
): Promise<string> {
  if (process.env.JIMENG_SKIP_LOCAL_PREVIEW === '1') return remoteUrl
  if (!remoteUrl.startsWith('http')) return remoteUrl
  onProgress?.({
    percent: 97,
    label: '正在缓存成片以便预览…',
    detail: '内嵌播放更稳定；「原链」仍为官方地址',
  })
  try {
    const res = await mainFetch(remoteUrl, {
      headers: {
        Referer: 'https://www.volcengine.com/',
        Origin: 'https://www.volcengine.com',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'video/*,*/*;q=0.9',
      },
    })
    if (!res.ok) return remoteUrl
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 256) return remoteUrl
    const dest = path.join(
      os.tmpdir(),
      `${JIMENG_PREVIEW_FILENAME_PREFIX}${randomUUID()}.mp4`,
    )
    fs.writeFileSync(dest, buf)
    if (process.env.JIMENG_PREVIEW_USE_FILE_URL === '1') {
      return pathToFileURL(dest).href
    }
    return toJimengLocalPreviewUrl(dest)
  } catch {
    return remoteUrl
  }
}

function resolveFfprobePath(): string {
  const fromEnv = process.env.FFPROBE_PATH?.trim()
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  try {
    const ffm = require('ffmpeg-static') as string | null | undefined
    if (ffm && fs.existsSync(ffm)) {
      const dir = path.dirname(ffm)
      const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      const sibling = path.join(dir, name)
      if (fs.existsSync(sibling)) return sibling
    }
  } catch {
    /* optional */
  }
  return 'ffprobe'
}

async function probeAudioDurationSeconds(
  audioPath: string,
): Promise<number | null> {
  const probeBin = resolveFfprobePath()
  return new Promise((resolve) => {
    const child = spawn(probeBin, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ])
    let out = ''
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      const sec = parseFloat(out.trim())
      resolve(Number.isFinite(sec) && sec > 0 ? sec : null)
    })
  })
}

/** IAM，与控制台「访问密钥」一致 */
export function volcIamCredentials(): { ak: string; sk: string } | null {
  return effectiveVolcIam()
}

function parseCommaList(csv: string): string[] {
  return csv
    .split(/[,，]/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 视觉 IAM req_key 降级链（运行时读 env） */
export function resolveVisualReqKeyChain(): string[] {
  const chainEnv = process.env.JIMENG_VISUAL_REQ_KEY_CHAIN?.trim()
  if (chainEnv) return parseCommaList(chainEnv)
  const single = process.env.JIMENG_VISUAL_REQ_KEY?.trim()
  if (single) return [single]
  return parseCommaList(DEFAULT_VISUAL_REQ_KEY_CHAIN_CSV)
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 额度/配额/限流等：可换下一模型；非此类错误则立即抛出以免无效重试。
 */
function isRetryableQuotaOrCapacityError(err: unknown): boolean {
  const msg = errorText(err)
  const low = msg.toLowerCase()
  if (
    /额度|配额|耗尽|用完|欠费|余额不足|余额已|免费额度|资源包|试用.*结束|售罄|限购|限流/i.test(
      msg,
    )
  )
    return true
  if (
    /\bquota|insufficient|exhausted|throttl|rate\s*limit|too\s+many\s+requests|429\b|402\b|resource\s*unavailable|billing|payment\s+required/i.test(
      low,
    )
  )
    return true
  // 当前账号未开通该 req_key、或 key 已下线：换链下一档（与额度耗尽同理）
  if (/50200.*req_key|req_key[^\n]{0,160}not\s+supported/i.test(low))
    return true
  return false
}

/** 视觉接口常用时长档位（秒），与语音对齐、避免浪费过长成片 */
function visualDurationTiersSec(): number[] {
  const raw = process.env.JIMENG_VISUAL_DURATION_TIERS?.trim()
  if (raw) {
    const xs = raw
      .split(/[,\s]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (xs.length) return [...new Set(xs)].sort((a, b) => a - b)
  }
  return [4, 5, 6, 8, 10]
}

function pickVisualGenerationDurationSeconds(voiceSec: number): number {
  const tiers = visualDurationTiersSec()
  const target = Math.max(0.25, voiceSec)
  for (const t of tiers) {
    if (t + 1e-6 >= target) return t
  }
  return tiers[tiers.length - 1]!
}

/** 与官方示例一致：约 24fps 下「帧数 ≈ 时长×24+1」 */
function framesForDurationSec(sec: number): number {
  const fps =
    parseInt(process.env.JIMENG_VISUAL_FPS?.trim() || '24', 10) || 24
  return Math.round(sec * fps) + 1
}

function normalizePromptTokens(xs: string[] | null | undefined, max: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of xs ?? []) {
    const t = s.trim()
    if (t.length < 2) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

/**
 * 文生视频提示：先中文剧情锚点（即梦/火山模型对汉语语义敏感），再英文镜头语法，最后约束与负向。
 * 结构参考常见 TI2V：主体/行为/环境/光效/镜头 + 与口播强制对齐。
 */
export function buildJimengVisualPrompt(options: {
  narrationZh: string
  shotDescriptionEn?: string | null
  visualHintEn?: string | null
  mustIncludeEn?: string[] | null
  avoidSubjectsEn?: string[] | null
  stockQueriesEn?: string[] | null
}): string {
  const zh = options.narrationZh.trim()
  const zhClip = zh.slice(0, 320)
  const shot = options.shotDescriptionEn?.trim() ?? ''
  const hint = options.visualHintEn?.trim() ?? ''
  const queries = normalizePromptTokens(options.stockQueriesEn, 4)
  const must = normalizePromptTokens(options.mustIncludeEn, 8)
  const avoid = normalizePromptTokens(options.avoidSubjectsEn, 8)

  const primaryShot = shot || queries[0] || ''
  const extraQueries = shot ? queries : queries.slice(1)

  const blocks: string[] = []

  blocks.push(
    `【中文剧情锚点】成片必须与下列口播在事实与情绪上一致；画面人物/物体/场景需能支撑这句解说：${zhClip}`,
  )

  if (primaryShot) {
    const tail = hint ? `。导演补充：${hint}` : ''
    blocks.push(
      `【英文镜头主体】${primaryShot}${tail}。Use concrete nouns and verbs; show identifiable subjects and setting.`,
    )
  } else if (hint) {
    blocks.push(
      `【英文镜头主体】${hint}。Infer a realistic location and action that match the Chinese narration above.`,
    )
  } else {
    blocks.push(
      '【英文镜头主体】Infer a single continuous real-world scene (who/what/where/action) that literally illustrates the Chinese narration above.',
    )
  }

  if (must.length) {
    blocks.push(
      `【画面必须出现】镜头中需清晰可见：${must.join('；')}（与口播及检索词一致，勿替换为无关物体）。`,
    )
  }

  if (extraQueries.length) {
    blocks.push(
      `【画面检索一致性】下列英文检索角度用于构图参考，不得偏离口播主题：${extraQueries.join('；')}`,
    )
  }

  if (avoid.length) {
    blocks.push(
      `【避免误导主体】不要让下列无关事物成为画面主角：${avoid.join('；')}。`,
    )
  }

  blocks.push(
    '【影像风格】写实摄影或电影感；自然光或柔和室内光；稳定或缓慢推拉镜头；禁止画面内字幕、水印、台标、贴纸、二维码。',
  )

  return blocks.filter(Boolean).join('\n').slice(0, 4000)
}

async function resolveJimengFinalPrompt(
  options: {
    narrationZh: string
    shotDescriptionEn?: string | null
    visualHintEn?: string | null
    mustIncludeEn?: string[] | null
    avoidSubjectsEn?: string[] | null
    stockQueriesEn?: string[] | null
  },
  onProgress?: (p: JimengProgressPayload) => void,
): Promise<string> {
  const heuristic = buildJimengVisualPrompt(options)
  const dsKey = effectiveDashscopeApiKey()
  if (!dsKey || process.env.JIMENG_PROMPT_REFINE?.trim() === 'false') {
    return heuristic
  }

  onProgress?.({
    percent: 8,
    label: '精炼即梦提示词…',
    detail: '用语义模型收紧画面与口播一致性',
  })

  try {
    const refined = await refinePromptForJimengVideo({
      apiKey: dsKey,
      narrationZh: options.narrationZh,
      shotDescriptionEn: options.shotDescriptionEn,
      visualHintEn: options.visualHintEn,
      mustIncludeEn: options.mustIncludeEn ?? undefined,
      avoidSubjectsEn: options.avoidSubjectsEn ?? undefined,
      stockQueriesEn: options.stockQueriesEn ?? undefined,
      heuristicDraft: heuristic,
    })
    const t = refined.trim()
    if (t.length >= 32) return t.slice(0, 3800)
  } catch {
    /* 使用结构化草稿 */
  }
  return heuristic
}

function readVisualHttpError(json: unknown): string | null {
  const o = json as {
    ResponseMetadata?: {
      Error?: { Code?: string; Message?: string; CodeN?: number }
    }
    code?: number
    message?: string
  }
  const e = o.ResponseMetadata?.Error
  if (e?.Message) return `${e.Code ?? 'VisualAPI'}: ${e.Message}`
  // 部分视觉接口：顶层 code，10000 表示成功（非 IAM ResponseMetadata 信封）
  if (typeof o.code === 'number' && o.code !== 10000 && o.code !== 0) {
    const msg = typeof o.message === 'string' ? o.message : String(o.code)
    return `VisualAPI ${o.code}: ${msg}`
  }
  return null
}

function taskIdFromRecord(rec: Record<string, unknown>): string | null {
  const tid = rec.task_id ?? rec.taskId
  if (typeof tid === 'string' && tid.length > 0) return tid
  if (typeof tid === 'number' && Number.isFinite(tid)) return String(tid)
  return null
}

/** 兼容 Result 信封与 { code, data: { task_id } } 等即梦/视觉返回形态 */
function extractVisualTaskId(json: unknown): string | null {
  const o = json as Record<string, unknown>
  const r = o.Result
  if (r && typeof r === 'object') {
    const id = taskIdFromRecord(r as Record<string, unknown>)
    if (id) return id
  }
  const d = o.data
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const id = taskIdFromRecord(d as Record<string, unknown>)
    if (id) return id
  }
  return taskIdFromRecord(o)
}

/** 异步查询结果：可能是 Result 或 data 载荷 */
function unwrapVisualTaskBody(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.Result && typeof o.Result === 'object') {
    return o.Result as Record<string, unknown>
  }
  if (o.data && typeof o.data === 'object' && !Array.isArray(o.data)) {
    return o.data as Record<string, unknown>
  }
  return null
}

function parseMaybeJsonObject(
  v: unknown,
): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v))
    return v as Record<string, unknown>
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v) as unknown
      if (p && typeof p === 'object' && !Array.isArray(p))
        return p as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

function extractVideoUrlFromVisualResult(
  result: Record<string, unknown>,
): string | null {
  const direct = ['video_url', 'videoUrl', 'url'] as const
  for (const k of direct) {
    const v = result[k]
    if (typeof v === 'string' && v.startsWith('http')) return v
  }
  const nested = parseMaybeJsonObject(result.data ?? result.Data)
  if (nested) {
    for (const k of direct) {
      const v = nested[k]
      if (typeof v === 'string' && v.startsWith('http')) return v
    }
  }
  const resp = result.resp_json ?? result.respJson
  const pj = parseMaybeJsonObject(resp)
  if (pj) {
    for (const k of direct) {
      const v = pj[k]
      if (typeof v === 'string' && v.startsWith('http')) return v
    }
  }
  return null
}

function coercePercent(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= 0 && v <= 1) return Math.round(v * 100)
    if (v > 1 && v <= 100) return Math.round(v)
  }
  if (typeof v === 'string') {
    const x = parseFloat(v)
    if (Number.isFinite(x)) {
      if (x >= 0 && x <= 1) return Math.round(x * 100)
      if (x > 1 && x <= 100) return Math.round(x)
    }
  }
  return null
}

/** 从视觉查询结果中提取 0～100 的进度（若接口提供） */
function extractNumericProgressPercent(
  r: Record<string, unknown>,
): number | null {
  const keys = [
    'progress',
    'percent',
    'percentage',
    'process_percent',
    'ratio',
    'Progress',
  ] as const
  for (const k of keys) {
    const n = coercePercent(r[k])
    if (n !== null) return n
  }
  const nestedKeys = ['resp_json', 'respJson', 'resp_data', 'RespData'] as const
  for (const nk of nestedKeys) {
    const nested = parseMaybeJsonObject(r[nk])
    if (!nested) continue
    for (const k of keys) {
      const n = coercePercent(nested[k])
      if (n !== null) return n
    }
  }
  return null
}

/** 用于进度文案的任务状态（过滤无关数字状态码） */
function extractStatusLabelForProgress(
  r: Record<string, unknown>,
): string | null {
  const st = r.status ?? r.Status ?? r.task_status ?? r.TaskStatus
  if (typeof st === 'string') return st
  if (typeof st === 'number') {
    if (st === 10000) return null
    if (st === 2 || st === 100) return '已完成'
    return `状态 ${st}`
  }
  return null
}

function formatJimengTimingDetail(
  voiceSec: number,
  genSec: number,
  statusHint: string | null,
): string {
  const core = `口播 ${voiceSec.toFixed(1)}s · 成片档位 ${genSec}s`
  if (statusHint) return `${core} · ${statusHint}`
  return `${core} · 生成中`
}

function visualTaskFinishedSuccess(result: Record<string, unknown>): boolean {
  const st = result.status ?? result.Status ?? result.task_status
  if (typeof st === 'number') return st === 2 || st === 100
  if (typeof st === 'string') {
    const s = st.toLowerCase()
    return ['done', 'success', 'succeed', 'completed', 'finish', 'successed'].includes(
      s,
    )
  }
  return false
}

function visualTaskFailed(result: Record<string, unknown>): boolean {
  const st = result.status ?? result.Status
  if (typeof st === 'string') {
    return ['failed', 'error', 'fail', 'cancelled', 'canceled'].includes(
      st.toLowerCase(),
    )
  }
  if (typeof st === 'number') return st < 0
  return false
}

async function callVisualCv(
  action: 'CVSync2AsyncSubmitTask' | 'CVSync2AsyncGetResult',
  bodyObj: Record<string, unknown>,
  creds: { ak: string; sk: string },
): Promise<unknown> {
  const params = { Action: action, Version: VISUAL_VERSION }
  const body = JSON.stringify(bodyObj)
  const request: RequestObj = {
    region: VISUAL_REGION,
    method: 'POST',
    params,
    headers: {
      Region: VISUAL_REGION,
      Service: 'cv',
      'Content-Type': 'application/json',
    },
    body,
  }
  const signer = new Signer(request, 'cv')
  signer.addAuthorization({
    accessKeyId: creds.ak,
    secretKey: creds.sk,
  })
  const qs = new URLSearchParams(params as Record<string, string>).toString()
  const res = await mainFetch(`${VISUAL_HOST}?${qs}`, {
    method: 'POST',
    headers: request.headers as Record<string, string>,
    body: request.body as string,
  })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch {
    throw new Error(`视觉接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 500)}`)
  }
  const apiErr = readVisualHttpError(json)
  if (apiErr) throw new Error(apiErr)
  if (!res.ok) {
    throw new Error(`视觉接口 HTTP ${res.status}：${text.slice(0, 700)}`)
  }
  return json
}

async function pollVisualUntilVideoUrl(
  reqKey: string,
  taskId: string,
  creds: { ak: string; sk: string },
  timing: { voiceSec: number; genSec: number },
  onProgress?: (p: JimengProgressPayload) => void,
): Promise<string> {
  const maxAttempts =
    parseInt(process.env.JIMENG_VISUAL_POLL_MAX?.trim() || '120', 10) || 120
  const intervalMs =
    parseInt(process.env.JIMENG_VISUAL_POLL_INTERVAL_MS?.trim() || '4000', 10) ||
    4000

  const pollStart = Date.now()
  const estimateMs = Math.min(
    360_000,
    Math.max(50_000, timing.genSec * 14_000),
  )
  let lastPct = 40

  const bumpProgress = (result: Record<string, unknown> | null) => {
    const elapsed = Date.now() - pollStart
    const timePct = 42 + Math.min(48, (elapsed / estimateMs) * 48)
    let apiMapped = 0
    if (result) {
      const apiPct = extractNumericProgressPercent(result)
      if (apiPct !== null) apiMapped = 42 + (apiPct / 100) * 50
    }
    let next = Math.max(lastPct, timePct, apiMapped)
    const statusLbl = result ? extractStatusLabelForProgress(result) : null
    next = Math.min(93, Math.round(next))
    lastPct = next
    onProgress?.({
      percent: next,
      label: '即梦正在生成视频…',
      detail: formatJimengTimingDetail(
        timing.voiceSec,
        timing.genSec,
        statusLbl,
      ),
      voiceDurationSec: timing.voiceSec,
      targetGenDurationSec: timing.genSec,
      serverStatusLabel: statusLbl ?? undefined,
    })
  }

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0)
      await new Promise((r) => setTimeout(r, intervalMs))

    const raw = await callVisualCv(
      'CVSync2AsyncGetResult',
      { req_key: reqKey, task_id: taskId },
      creds,
    )
    let result = unwrapVisualTaskBody(raw)
    if (!result || typeof result !== 'object') {
      bumpProgress(null)
      continue
    }

    const nested = parseMaybeJsonObject(result.data ?? result.Data)
    if (nested && Object.keys(nested).length > 0) {
      result = { ...result, ...nested }
    }

    bumpProgress(result)

    const url = extractVideoUrlFromVisualResult(result)
    if (url) {
      onProgress?.({
        percent: 96,
        label: '已拿到成片地址',
        detail: formatJimengTimingDetail(
          timing.voiceSec,
          timing.genSec,
          '已就绪',
        ),
        voiceDurationSec: timing.voiceSec,
        targetGenDurationSec: timing.genSec,
      })
      return url
    }
    if (visualTaskFailed(result)) {
      const reason =
        (typeof result.message === 'string' && result.message) ||
        (typeof result.Message === 'string' && result.Message) ||
        JSON.stringify(result).slice(0, 400)
      throw new Error(`即梦生成失败：${reason}`)
    }
    if (visualTaskFinishedSuccess(result) && !url) {
      continue
    }
  }
  throw new Error('即梦视频生成超时，请稍后重试')
}

export interface JimengGenerateResult {
  video: UnifiedStockVideo
  voiceDurationSec: number
  chosenGenDurationSec: number
}

/** 单次视觉 IAM 即梦生成（指定 req_key） */
async function runVisualJimengOnce(
  reqKey: string,
  iam: { ak: string; sk: string },
  prompt: string,
  voiceDur: number,
  genDur: number,
  onProgress?: (p: JimengProgressPayload) => void,
): Promise<JimengGenerateResult> {
  const aspect =
    process.env.JIMENG_VISUAL_ASPECT_RATIO?.trim() || '16:9'
  const frames = framesForDurationSec(genDur)
  const seedRaw = process.env.JIMENG_VISUAL_SEED?.trim()
  const seed =
    seedRaw === undefined || seedRaw === ''
      ? -1
      : parseInt(seedRaw, 10) || -1

  const submitBody: Record<string, unknown> = {
    req_key: reqKey,
    prompt,
    seed,
    frames,
    aspect_ratio: aspect,
  }

  const submitRaw = await callVisualCv(
    'CVSync2AsyncSubmitTask',
    submitBody,
    iam,
  )
  const taskId = extractVisualTaskId(submitRaw)
  if (!taskId) {
    throw new Error(
      `视觉接口未返回 task_id：${JSON.stringify(submitRaw).slice(0, 600)}`,
    )
  }

  onProgress?.({
    percent: 38,
    label: '任务已提交（视觉接口）',
    detail: formatJimengTimingDetail(voiceDur, genDur, '排队/生成中'),
    voiceDurationSec: voiceDur,
    targetGenDurationSec: genDur,
  })

  const videoUrl = await pollVisualUntilVideoUrl(
    reqKey,
    taskId,
    iam,
    { voiceSec: voiceDur, genSec: genDur },
    onProgress,
  )

  const previewUrl = await mirrorJimengVideoForPreview(videoUrl, onProgress)

  onProgress?.({
    percent: 99,
    label: '即将加入候选列表',
    detail: formatJimengTimingDetail(voiceDur, genDur, '写入本段候选'),
    voiceDurationSec: voiceDur,
    targetGenDurationSec: genDur,
  })

  const video: UnifiedStockVideo = {
    source: 'jimeng',
    key: `jimeng-${taskId}`,
    pageUrl: videoUrl,
    duration: genDur,
    authorName: '即梦 AI',
    thumbnailUrl: '',
    previewVideoUrl: previewUrl,
    rerankText: `jimeng visual ${reqKey} ${prompt.slice(0, 200)}`,
  }

  return {
    video,
    voiceDurationSec: voiceDur,
    chosenGenDurationSec: genDur,
  }
}

export async function generateJimengSegmentVideo(options: {
  narrationZh: string
  shotDescriptionEn?: string | null
  visualHintEn?: string | null
  mustIncludeEn?: string[] | null
  avoidSubjectsEn?: string[] | null
  stockQueriesEn?: string[] | null
  ttsApiKey: string
  ttsResourceId: string
  ttsSpeaker: string
  onProgress?: (p: JimengProgressPayload) => void
}): Promise<JimengGenerateResult> {
  const onProgress = options.onProgress
  const iam = volcIamCredentials()

  if (!iam) {
    throw new Error(
      '请先在「密钥设置」中填写火山访问密钥（Access Key ID 与 Secret Access Key），用于即梦等 AI 视频接口。',
    )
  }

  onProgress?.({
    percent: 4,
    label: '准备画面提示词…',
    detail:
      effectiveDashscopeApiKey() &&
      process.env.JIMENG_PROMPT_REFINE !== 'false'
        ? '结构化约束 + 可选 DashScope 精炼'
        : '结构化画面锚点与口播对齐',
  })

  const prompt = await resolveJimengFinalPrompt(options, onProgress)

  onProgress?.({
    percent: 11,
    label: '连接视频生成服务…',
    detail: `火山 IAM：视觉 req_key 链（${resolveVisualReqKeyChain().join(' → ')}）`,
  })

  onProgress?.({
    percent: 12,
    label: '合成豆包语音…',
    detail: '测量本段口播时长并选择生成档位',
  })

  const tmpMp3 = path.join(os.tmpdir(), `story-stock-jimeng-tts-${randomUUID()}.mp3`)
  const b64 = await synthesizeDoubaoTtsMp3Base64({
    apiKey: options.ttsApiKey,
    resourceId: options.ttsResourceId,
    speaker: options.ttsSpeaker,
    text: options.narrationZh.trim(),
  })
  fs.writeFileSync(tmpMp3, Buffer.from(b64, 'base64'))
  const voiceDur = (await probeAudioDurationSeconds(tmpMp3)) ?? 5
  try {
    fs.unlinkSync(tmpMp3)
  } catch {
    /* */
  }

  const genDurVisual = pickVisualGenerationDurationSeconds(voiceDur)

  onProgress?.({
    percent: 26,
    label: `语音约 ${voiceDur.toFixed(1)}s → 选用 ${genDurVisual}s 档位`,
    detail: formatJimengTimingDetail(
      voiceDur,
      genDurVisual,
      '将按 req_key 链生成（额度耗尽自动换档）',
    ),
    voiceDurationSec: voiceDur,
    targetGenDurationSec: genDurVisual,
  })

  const failures: string[] = []

  const visualKeys = resolveVisualReqKeyChain()
  for (let i = 0; i < visualKeys.length; i++) {
    const reqKey = visualKeys[i]!
    try {
      onProgress?.({
        percent: 29,
        label: '视觉智能生成…',
        detail: `[${i + 1}/${visualKeys.length}] req_key=${reqKey}`,
        voiceDurationSec: voiceDur,
        targetGenDurationSec: genDurVisual,
      })
      return await runVisualJimengOnce(
        reqKey,
        iam,
        prompt,
        voiceDur,
        genDurVisual,
        onProgress,
      )
    } catch (e) {
      failures.push(`视觉 ${reqKey}: ${errorText(e).slice(0, 260)}`)
      if (!isRetryableQuotaOrCapacityError(e)) {
        throw e instanceof Error ? e : new Error(errorText(e))
      }
      onProgress?.({
        percent: 30,
        label: '切换视觉 req_key…',
        detail: `${reqKey} 不可用，尝试下一档`,
        voiceDurationSec: voiceDur,
        targetGenDurationSec: genDurVisual,
      })
    }
  }

  throw new Error(
    failures.length > 0
      ? `即梦视频生成失败（已尝试全部降级）。\n${failures.join('\n')}`
      : '即梦视频生成失败：视觉 req_key 链为空。',
  )
}
