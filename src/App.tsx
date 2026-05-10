import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExportVideoProgress } from '@/types/exportVideo'
import type { JimengVideoProgress } from '@/types/jimengVideo'
import type {
  UserApiSettingsPatch,
  UserApiSettingsPublic,
} from '@/types/userApiSettings'
import type { AuthUser } from '@/types/auth'
import type { UsagePublicStatus } from '@/types/usage'
import { MAX_LICENSE_PURCHASE_DAYS_PER_REQUEST } from '@/types/usage'
import type { UnifiedStockVideo } from '@/types/stockVideo'
import { mapPool } from '@/lib/mapPool'
import { segmentStory } from '@/lib/segment'
import { suggestStockSearchQuery } from '@/lib/suggestQuery'
import {
  DOUBAO_RESOURCE_PRESETS,
  voicesForResourceId,
} from '@/data/doubaoVoiceCatalog'
import LoginScreen from '@/components/LoginScreen'
import './App.css'

/** `runSegment` / `runMaterialsForAllRows` 用户点击「暂停生成」时抛出，用于中止队列；长 IPC 用 `raceAbort` 从等待中提前返回（主进程仍可能把请求跑完） */
const GENERATION_ABORT_MSG = 'GENERATION_ABORTED'

function isGenerationAbortError(e: unknown): boolean {
  return e instanceof Error && e.message === GENERATION_ABORT_MSG
}

function throwIfGenerationAborted(ref: { current: boolean }): void {
  if (ref.current) throw new Error(GENERATION_ABORT_MSG)
}

/**
 * 主进程 IPC 无内置超时；DashScope / 外部 API 挂起时界面会永久「搜索中…」。
 * 用 Promise.race 在超时后结束等待（后台请求仍可能继续，但 UI 可恢复）。
 */
async function withIpcTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label}超时（${Math.round(ms / 1000)}s）。请检查网络；若在密钥设置中已填写，多为阿里云 DashScope 或 Pexels/Pixabay 响应过慢 / 限流。`,
            ),
          )
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 与长耗时 IPC 竞速：暂停按钮只改 ref，原先若在 await 里要等接口返回才有反应；
 * 此处轮询 ref，用户点击后约一轮询间隔内即可抛 GENERATION_ABORT_MSG。
 * （主进程请求仍可能在后台跑完，无法从渲染进程中断。）
 */
async function raceAbort<T>(
  promise: Promise<T>,
  abortRef: { current: boolean },
  pollMs = 120,
): Promise<T> {
  let intervalId: number | undefined
  const tick = new Promise<T>((_, reject) => {
    intervalId = window.setInterval(() => {
      if (abortRef.current) {
        reject(new Error(GENERATION_ABORT_MSG))
      }
    }, pollMs)
  })
  try {
    return await Promise.race([promise, tick])
  } finally {
    if (intervalId !== undefined) clearInterval(intervalId)
  }
}

/** 生成英文检索词（DashScope Chat） */
const IPC_GENERATE_VISUAL_QUERIES_MS = 120_000
/** 素材合并搜索 + 可选向量对齐与语义重排序（可能多次请求 DashScope） */
const IPC_STOCK_SEARCH_MS = 240_000

/** 分段自动搜素材 / 「全部重新搜索」并行度（可用 .env 覆盖） */
function stockSearchParallelism(): number {
  const raw = import.meta.env.VITE_STOCK_SEARCH_CONCURRENCY?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 1 && n <= 32) return n
  return 6
}

/** 候选成片后台完整缓存到 userData（与导出同源 URL），降低导出时再下载的耗时（主进程另有 STOCK_CACHE_MAX_CONCURRENCY 上限） */
function stockCachePrefetchParallelism(): number {
  const raw = import.meta.env.VITE_STOCK_CACHE_CONCURRENCY?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 1 && n <= 32) return n
  return 8
}

/** 展开「另选素材」时最多展示前 N 条高分候选（含默认可见的第 1 条，共 N 条） */
const STOCK_UI_EXPAND_TOTAL = 8

/** 飞书文档：密钥配置说明 */
const KEYS_SETUP_DOC_URL =
  'https://jcnz4dgvxul3.feishu.cn/wiki/WbUPwKazmiJBbBkRG2mceu3xnHc?from=from_copylink'

/**
 * 登录后横幅：必备项为阿里云、豆包 TTS、素材站（二选一）。
 * 火山 IAM 为可选项，不配则不可使用即梦等 AI 文生视频。
 */
function apiKeysGuideSatisfied(v: UserApiSettingsPublic): boolean {
  const stockOk = v.pexelsConfigured || v.pixabayConfigured
  return v.dashscopeConfigured && v.volcTtsConfigured && stockOk
}

/** 试用结束后充值积分（与 AUTH_API_BASE 同源站点账户页，可 VITE_AUTH_ACCOUNT_URL 覆盖） */
const USAGE_ACCOUNT_URL =
  import.meta.env.VITE_AUTH_ACCOUNT_URL?.trim() ||
  'https://aiganhuole.com/account'

const LS_TTS_RES = 'story-stock.volcTtsResourceId'
const LS_TTS_SPK = 'story-stock.volcTtsSpeaker'
const LS_TTS_MANUAL = 'story-stock.volcTtsSpeakerManual'

interface SegmentRow {
  id: number
  text: string
  query: string
  /** 阿里云「画面向」多检索词；有则搜索时多路并行并去重，再用口播句重排 */
  queriesForSearch?: string[]
  /** 口播分段附带的英文画面提示，参与 AI 生成检索词 */
  visualHintEn?: string | null
  /** AI 生成的「这一镜在拍什么」英句，便于对照 */
  aiShotDescriptionEn?: string | null
  /** 检索/排序锚词（英文），来自阿里云检索 JSON */
  aiMustIncludeEn?: string[]
  aiAvoidSubjectsEn?: string[]
  videos: UnifiedStockVideo[]
  /** 本段选中的素材 key，与 `videos[].key` 对应 */
  selectedVideoKey: string | null
  loading: boolean
  error: string | null
  /** 某一素材站失败时的提示，不影响另一站结果 */
  searchWarning?: string | null
}

/**
 * 保证各段已选素材 key 全局不重复：按段 id 升序，保留仍有效的选择，否则从本段列表中选第一个尚未被占用的 key。
 */
function resolveUniqueSelections(rows: SegmentRow[]): SegmentRow[] {
  const used = new Set<string>()
  const sorted = [...rows].sort((a, b) => a.id - b.id)
  const newKeys = new Map<number, string | null>()

  for (const row of sorted) {
    const available = row.videos.filter((v) => !used.has(v.key))
    let key: string | null = row.selectedVideoKey

    if (key && used.has(key)) key = null
    if (key && !row.videos.some((v) => v.key === key)) key = null
    if (
      key &&
      available.some((v) => v.key === key)
    ) {
      used.add(key)
      newKeys.set(row.id, key)
      continue
    }

    const fallback = available[0]?.key ?? null
    if (fallback) used.add(fallback)
    newKeys.set(row.id, fallback)
  }

  return rows.map((r) => ({
    ...r,
    selectedVideoKey: newKeys.get(r.id) ?? null,
  }))
}

/** 把当前选用素材排到候选列表第一位，折叠预览与导出均以「选用」为准 */
function orderVideosSelectedFirst(
  videos: UnifiedStockVideo[],
  selectedKey: string | null,
): UnifiedStockVideo[] {
  if (!selectedKey) return videos
  const ix = videos.findIndex((v) => v.key === selectedKey)
  if (ix <= 0) return videos
  const chosen = videos[ix]!
  return [chosen, ...videos.filter((v) => v.key !== selectedKey)]
}

/** 去重选用后，每段 videos 顺序调整为「选用 → 其余保持原相对顺序」 */
function rowsWithSelectedVideoFirst(rows: SegmentRow[]): SegmentRow[] {
  return rows.map((row) => ({
    ...row,
    videos: orderVideosSelectedFirst(row.videos, row.selectedVideoKey),
  }))
}

function resolveUniqueSelectionsWithOrder(rows: SegmentRow[]): SegmentRow[] {
  return rowsWithSelectedVideoFirst(resolveUniqueSelections(rows))
}

/** 选中素材完整缓存；其余候选仅前缀预览（主进程 tiered 预取） */
function buildStockCachePrefetchLists(rows: SegmentRow[]): {
  fullVideos: UnifiedStockVideo[]
  previewVideos: UnifiedStockVideo[]
} {
  const fullKeys = new Set<string>()
  const fullVideos: UnifiedStockVideo[] = []
  for (const r of rows) {
    const sel = r.selectedVideoKey
    if (!sel) continue
    const v = r.videos.find((x) => x.key === sel)
    if (v?.previewVideoUrl?.trim()) {
      if (!fullKeys.has(v.key)) {
        fullKeys.add(v.key)
        fullVideos.push(v)
      }
    }
  }
  const previewKeys = new Set<string>()
  const previewVideos: UnifiedStockVideo[] = []
  for (const r of rows) {
    for (const v of r.videos) {
      if (!v.previewVideoUrl?.trim()) continue
      if (v.key === r.selectedVideoKey) continue
      if (fullKeys.has(v.key)) continue
      if (!previewKeys.has(v.key)) {
        previewKeys.add(v.key)
        previewVideos.push(v)
      }
    }
  }
  return { fullVideos, previewVideos }
}

/** Pexels/Pixabay：本地缓存播放；预览档在首次播放时补全下载 */
function StockPreviewVideo({
  video: v,
  cacheRev,
}: {
  video: UnifiedStockVideo
  cacheRev: number
}) {
  const remote = v.previewVideoUrl?.trim() ?? ''
  const [src, setSrc] = useState(remote)
  const [playKind, setPlayKind] = useState<'full' | 'preview' | 'remote'>(
    'remote',
  )

  useEffect(() => {
    let cancelled = false
    setSrc(remote)
    setPlayKind('remote')
    const run = async () => {
      if (typeof window.storyStock?.stockCacheResolvePlayUrl !== 'function')
        return
      try {
        const r = await window.storyStock.stockCacheResolvePlayUrl(v)
        if (cancelled || !r?.url) return
        setSrc(r.url)
        setPlayKind(r.kind)
      } catch {
        /* 保持远程 URL */
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [v.key, remote, cacheRev])

  const onPlay = async () => {
    if (playKind !== 'preview') return
    if (typeof window.storyStock?.stockCacheEnsureFull !== 'function') return
    try {
      const r = await window.storyStock.stockCacheEnsureFull(v)
      if (r?.url) {
        setSrc(r.url)
        setPlayKind(r.kind)
      }
    } catch {
      /* ignore */
    }
  }

  return (
    <video
      key={`${v.key}-${cacheRev}`}
      className='preview-player'
      controls
      playsInline
      preload='metadata'
      poster={v.thumbnailUrl || undefined}
      src={src}
      onPlay={onPlay}
      onError={(ev) => {
        const el = ev.currentTarget
        if (v.source !== 'jimeng') return
        if (el.dataset.jimengFallback === '1') return
        el.dataset.jimengFallback = '1'
        const remotePage = v.pageUrl?.trim()
        if (
          remotePage &&
          /^https:\/\//i.test(remotePage) &&
          typeof window.storyStock !== 'undefined'
        ) {
          el.src = `story-video://cdn/open?u=${encodeURIComponent(remotePage)}`
        }
      }}
    >
      您的环境不支持内嵌视频播放。
    </video>
  )
}

function speakTextBrowser(text: string, lang: string) {
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = lang
  u.rate = 0.95
  window.speechSynthesis.speak(u)
}

export default function App() {
  const [story, setStory] = useState('')
  const [rows, setRows] = useState<SegmentRow[]>([])
  const [globalError, setGlobalError] = useState<string | null>(null)
  const rowsRef = useRef<SegmentRow[]>([])
  const lastAudioRef = useRef<HTMLAudioElement | null>(null)

  const [ttsLoadingId, setTtsLoadingId] = useState<number | null>(null)
  const [jimengLoadingId, setJimengLoadingId] = useState<number | null>(null)
  const [jimengProgress, setJimengProgress] =
    useState<JimengVideoProgress | null>(null)
  /** 分段 + 自动生成检索 + 拉素材 的一体化进度 */
  const [pipeline, setPipeline] = useState<{ busy: boolean; label: string }>({
    busy: false,
    label: '',
  })
  const [exportLoading, setExportLoading] = useState(false)
  const [exportProgress, setExportProgress] =
    useState<ExportVideoProgress | null>(null)
  const [jianyingExportLoading, setJianyingExportLoading] = useState(false)
  const [jianyingExportProgress, setJianyingExportProgress] =
    useState<ExportVideoProgress | null>(null)
  /** 为 null 时本段只展示排序第 1 条；为某段 id 时展示前 STOCK_UI_EXPAND_TOTAL 条以便另选 */
  const [pickerOpenForId, setPickerOpenForId] = useState<number | null>(null)
  const generationAbortRef = useRef(false)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsView, setSettingsView] = useState<UserApiSettingsPublic | null>(
    null,
  )
  const [dashscopeKeyDraft, setDashscopeKeyDraft] = useState('')
  const [volcTtsKeyDraft, setVolcTtsKeyDraft] = useState('')
  const [volcAkDraft, setVolcAkDraft] = useState('')
  const [volcSkDraft, setVolcSkDraft] = useState('')
  const [pexelsKeyDraft, setPexelsKeyDraft] = useState('')
  const [pixabayKeyDraft, setPixabayKeyDraft] = useState('')
  const [settingsSavedHint, setSettingsSavedHint] = useState<string | null>(null)
  /** 登录成功后提示配置密钥，直至用户关闭 */
  const [postLoginKeysGuide, setPostLoginKeysGuide] = useState(false)

  /** 账号登录：boot 校验中；need 显示登录页；ok 进入主界面 */
  const [authGate, setAuthGate] = useState<'boot' | 'need' | 'ok'>('boot')
  const [sessionUser, setSessionUser] = useState<AuthUser | null>(null)
  const [usageStatus, setUsageStatus] = useState<UsagePublicStatus | null>(
    null,
  )
  const [usageGateLoading, setUsageGateLoading] = useState(false)
  const [purchaseDaysDraft, setPurchaseDaysDraft] = useState('1')
  const [purchaseErr, setPurchaseErr] = useState<string | null>(null)
  const [purchaseSubmitting, setPurchaseSubmitting] = useState(false)

  const [ttsResourceId, setTtsResourceId] = useState('seed-tts-1.0')
  const [ttsSpeaker, setTtsSpeaker] = useState(
    'zh_female_shuangkuaisisi_moon_bigtts',
  )
  const [ttsSpeakerManual, setTtsSpeakerManual] = useState('')

  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  /** 预取完成后递增，令预览播放器重新解析本地 stock-cache URL */
  const [stockCacheRev, setStockCacheRev] = useState(0)

  /** 选中项完整缓存 + 候选仅前缀预览；debounce 后 tiered 预取 */
  useEffect(() => {
    const tiered = window.storyStock?.prefetchStockVideoCacheTiered
    if (typeof tiered !== 'function') return
    const h = window.setTimeout(() => {
      const { fullVideos, previewVideos } = buildStockCachePrefetchLists(rows)
      if (fullVideos.length === 0 && previewVideos.length === 0) return
      void tiered({
        fullVideos,
        previewVideos,
        concurrencyPreview: stockCachePrefetchParallelism(),
      }).then(() => setStockCacheRev((x) => x + 1))
    }, 450)
    return () => clearTimeout(h)
  }, [rows])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let defaults = {
        resourceId: 'seed-tts-1.0',
        speaker: 'zh_female_shuangkuaisisi_moon_bigtts',
      }
      try {
        if (typeof window.storyStock?.getDoubaoTtsEnvDefaults === 'function') {
          defaults = await window.storyStock.getDoubaoTtsEnvDefaults()
        }
      } catch {
        /* 非 Electron 预览 */
      }
      if (cancelled) return
      const sr = localStorage.getItem(LS_TTS_RES)
      const ss = localStorage.getItem(LS_TTS_SPK)
      const sm = localStorage.getItem(LS_TTS_MANUAL)
      const rawRes = sr || defaults.resourceId
      const resId =
        rawRes === 'volc.service_type.10029' ? 'seed-tts-1.0' : rawRes
      setTtsResourceId(resId)
      setTtsSpeakerManual(sm ?? '')
      const voices = voicesForResourceId(resId)
      const cand = ss || defaults.speaker
      const valid = voices.some((v) => v.speaker === cand)
      setTtsSpeaker(valid ? cand : voices[0]?.speaker || cand)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(LS_TTS_RES, ttsResourceId)
  }, [ttsResourceId])

  useEffect(() => {
    localStorage.setItem(LS_TTS_SPK, ttsSpeaker)
  }, [ttsSpeaker])

  useEffect(() => {
    localStorage.setItem(LS_TTS_MANUAL, ttsSpeakerManual)
  }, [ttsSpeakerManual])

  const apiReady =
    typeof window.storyStock?.searchStockVideos === 'function' &&
    typeof window.storyStock?.searchStockForSegment === 'function' &&
    typeof window.storyStock?.segmentForVoiceOver === 'function' &&
    typeof window.storyStock?.generateVisualStockQueries === 'function' &&
    typeof window.storyStock?.synthesizeDoubaoTts === 'function' &&
    typeof window.storyStock?.getUserApiSettings === 'function'

  const exportReady =
    typeof window.storyStock?.exportNarratedVideo === 'function'

  const exportJianyingReady =
    typeof window.storyStock?.exportJianyingProject === 'function'

  const refreshSettingsView = useCallback(async () => {
    if (typeof window.storyStock?.getUserApiSettings !== 'function') return
    try {
      const v = await window.storyStock.getUserApiSettings()
      setSettingsView(v)
      setPostLoginKeysGuide(!apiKeysGuideSatisfied(v))
    } catch {
      setSettingsView(null)
      setPostLoginKeysGuide(true)
    }
  }, [])

  const openKeysSetupDoc = useCallback(() => {
    if (typeof window.storyStock?.openExternalUrl === 'function') {
      void window.storyStock.openExternalUrl(KEYS_SETUP_DOC_URL).catch(() => {
        window.open(KEYS_SETUP_DOC_URL, '_blank', 'noopener,noreferrer')
      })
    } else {
      window.open(KEYS_SETUP_DOC_URL, '_blank', 'noopener,noreferrer')
    }
  }, [])

  useEffect(() => {
    if (authGate !== 'ok' || !apiReady) return
    void refreshSettingsView()
  }, [authGate, apiReady, refreshSettingsView])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (typeof window.storyStock?.authGetState !== 'function') {
        setAuthGate('ok')
        return
      }
      try {
        const s = await window.storyStock.authGetState()
        if (cancelled) return
        if (s.loggedIn) {
          setSessionUser(s.user ?? null)
          setAuthGate('ok')
        } else {
          setAuthGate('need')
        }
      } catch {
        if (!cancelled) setAuthGate('need')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 登录后同步试用 / 积分 / 当日扣减（Electron） */
  useEffect(() => {
    if (authGate !== 'ok') return
    const usageSync = window.storyStock?.usageSyncStatus
    if (!apiReady || typeof usageSync !== 'function') {
      setUsageGateLoading(false)
      setUsageStatus(null)
      return
    }
    let cancelled = false
    const run = async () => {
      setUsageGateLoading(true)
      try {
        const s = await usageSync()
        if (!cancelled) setUsageStatus(s)
      } catch {
        if (!cancelled) setUsageStatus(null)
      } finally {
        if (!cancelled) setUsageGateLoading(false)
      }
    }
    void run()
    const id = window.setInterval(() => void run(), 5 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [authGate, apiReady])

  useEffect(() => {
    if (!usageStatus || usageStatus.canUseApp || !usageStatus.licenseApiOk) return
    const m = usageStatus.maxPurchasableDays
    if (m > 0)
      setPurchaseDaysDraft(String(Math.min(m, MAX_LICENSE_PURCHASE_DAYS_PER_REQUEST)))
  }, [usageStatus])

  const openUsageAccountPage = useCallback(() => {
    const url = USAGE_ACCOUNT_URL
    if (typeof window.storyStock?.openExternalUrl === 'function') {
      void window.storyStock.openExternalUrl(url).catch(() => {
        window.open(url, '_blank', 'noopener,noreferrer')
      })
    } else {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }, [])

  const tryPurchaseLicenseDays = useCallback(async () => {
    const fn = window.storyStock?.usagePurchaseDays
    if (typeof fn !== 'function' || !usageStatus || !usageStatus.licenseApiOk) return
    const max = usageStatus.maxPurchasableDays
    const d = Math.floor(Number(purchaseDaysDraft))
    if (!Number.isFinite(d) || d < 1 || d > max) {
      setPurchaseErr(`请输入 1～${max} 的整数`)
      return
    }
    setPurchaseErr(null)
    setPurchaseSubmitting(true)
    try {
      const r = await fn(d)
      if (r.ok) {
        setUsageStatus(r.status)
        setPurchaseErr(null)
      } else {
        setPurchaseErr(r.message)
        if (r.status) setUsageStatus(r.status)
        if (r.shouldOpenRecharge) openUsageAccountPage()
      }
    } catch (e) {
      setPurchaseErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPurchaseSubmitting(false)
    }
  }, [openUsageAccountPage, purchaseDaysDraft, usageStatus])

  const logoutApp = useCallback(async () => {
    if (typeof window.storyStock?.authLogout === 'function') {
      await window.storyStock.authLogout()
    }
    setSessionUser(null)
    setUsageStatus(null)
    setPostLoginKeysGuide(false)
    setAuthGate('need')
  }, [])

  const saveDashscopeKey = useCallback(async () => {
    if (typeof window.storyStock?.setUserApiSettings !== 'function') return
    const t = dashscopeKeyDraft.trim()
    if (!t) {
      setSettingsSavedHint('请先粘贴阿里云 API Key，再点保存')
      return
    }
    setSettingsSavedHint(null)
    try {
      const next = await window.storyStock.setUserApiSettings({
        dashscopeApiKey: t,
      })
      setSettingsView(next)
      setPostLoginKeysGuide(!apiKeysGuideSatisfied(next))
      setDashscopeKeyDraft('')
      setSettingsSavedHint('阿里云 API Key 已保存')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSettingsSavedHint(`保存失败：${msg}`)
    }
  }, [dashscopeKeyDraft])

  const savePexelsKey = useCallback(async () => {
    if (typeof window.storyStock?.setUserApiSettings !== 'function') return
    const t = pexelsKeyDraft.trim()
    if (!t) {
      setSettingsSavedHint('请先粘贴 Pexels Key，再点保存')
      return
    }
    setSettingsSavedHint(null)
    try {
      const next = await window.storyStock.setUserApiSettings({
        pexelsApiKey: t,
      })
      setSettingsView(next)
      setPostLoginKeysGuide(!apiKeysGuideSatisfied(next))
      setPexelsKeyDraft('')
      setSettingsSavedHint('Pexels Key 已保存')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSettingsSavedHint(`保存失败：${msg}`)
    }
  }, [pexelsKeyDraft])

  const savePixabayKey = useCallback(async () => {
    if (typeof window.storyStock?.setUserApiSettings !== 'function') return
    const t = pixabayKeyDraft.trim()
    if (!t) {
      setSettingsSavedHint('请先粘贴 Pixabay Key，再点保存')
      return
    }
    setSettingsSavedHint(null)
    try {
      const next = await window.storyStock.setUserApiSettings({
        pixabayApiKey: t,
      })
      setSettingsView(next)
      setPostLoginKeysGuide(!apiKeysGuideSatisfied(next))
      setPixabayKeyDraft('')
      setSettingsSavedHint('Pixabay Key 已保存')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSettingsSavedHint(`保存失败：${msg}`)
    }
  }, [pixabayKeyDraft])

  const saveVolcTtsKey = useCallback(async () => {
    if (typeof window.storyStock?.setUserApiSettings !== 'function') return
    const t = volcTtsKeyDraft.trim()
    if (!t) {
      setSettingsSavedHint('请先粘贴豆包 TTS 的 API Key，再点保存')
      return
    }
    setSettingsSavedHint(null)
    try {
      const next = await window.storyStock.setUserApiSettings({
        volcTtsApiKey: t,
      })
      setSettingsView(next)
      setPostLoginKeysGuide(!apiKeysGuideSatisfied(next))
      setVolcTtsKeyDraft('')
      setSettingsSavedHint('豆包 TTS Key 已保存')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSettingsSavedHint(`保存失败：${msg}`)
    }
  }, [volcTtsKeyDraft])

  const saveVolcIamKeys = useCallback(async () => {
    if (typeof window.storyStock?.setUserApiSettings !== 'function') return
    const ak = volcAkDraft.trim()
    const sk = volcSkDraft.trim()
    if (!ak || !sk) {
      setSettingsSavedHint('请同时填写 Access Key ID 与 Secret Access Key，再点保存')
      return
    }
    setSettingsSavedHint(null)
    try {
      const next = await window.storyStock.setUserApiSettings({
        volcAccessKeyId: ak,
        volcSecretAccessKey: sk,
      })
      setSettingsView(next)
      setPostLoginKeysGuide(!apiKeysGuideSatisfied(next))
      setVolcAkDraft('')
      setVolcSkDraft('')
      setSettingsSavedHint('火山访问密钥已保存（可使用 AI 文生视频）')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSettingsSavedHint(`保存失败：${msg}`)
    }
  }, [volcAkDraft, volcSkDraft])

  const clearUserApiField = useCallback(
    async (key: keyof UserApiSettingsPatch) => {
      if (typeof window.storyStock?.setUserApiSettings !== 'function') return
      const patch: UserApiSettingsPatch = { [key]: '' }
      const next = await window.storyStock.setUserApiSettings(patch)
      setSettingsView(next)
      setPostLoginKeysGuide(!apiKeysGuideSatisfied(next))
      setSettingsSavedHint('已清除该项')
    },
    [],
  )

  const clearVolcIamPair = useCallback(async () => {
    if (typeof window.storyStock?.setUserApiSettings !== 'function') return
    const next = await window.storyStock.setUserApiSettings({
      volcAccessKeyId: '',
      volcSecretAccessKey: '',
    })
    setSettingsView(next)
    setPostLoginKeysGuide(!apiKeysGuideSatisfied(next))
    setSettingsSavedHint('已清除火山访问密钥')
  }, [])

  const ttsVoiceList = useMemo(
    () => voicesForResourceId(ttsResourceId),
    [ttsResourceId],
  )

  const ttsSpeakerSelectValue = useMemo(() => {
    if (ttsVoiceList.some((v) => v.speaker === ttsSpeaker)) return ttsSpeaker
    return ttsVoiceList[0]?.speaker ?? ttsSpeaker
  }, [ttsVoiceList, ttsSpeaker])

  const applyLocalSegment = useCallback((source: string): SegmentRow[] => {
    const segments = segmentStory(source)
    const next: SegmentRow[] = segments.map((s) => ({
      id: s.id,
      text: s.text,
      query: suggestStockSearchQuery(s.text),
      queriesForSearch: undefined,
      visualHintEn: null,
      aiShotDescriptionEn: null,
      aiMustIncludeEn: undefined,
      aiAvoidSubjectsEn: undefined,
      videos: [],
      selectedVideoKey: null,
      loading: false,
      error: null,
      searchWarning: null,
    }))
    setRows(next)
    return next
  }, [])

  /** 分段完成后：自动画面检索词 + 多源搜索 + 口播重排（无需用户再点「AI 生成」） */
  const runMaterialsForAllRows = useCallback(
    async (
      items: Array<{
        id: number
        text: string
        visualHintEn: string | null
      }>,
    ) => {
      const canQ =
        typeof window.storyStock?.generateVisualStockQueries === 'function'
      const smart =
        typeof window.storyStock?.searchStockForSegment === 'function'
      const basic =
        typeof window.storyStock?.searchStockVideos === 'function'

      if (!canQ || (!smart && !basic)) return

      await mapPool(items, stockSearchParallelism(), async (item) => {
        throwIfGenerationAborted(generationAbortRef)
        const id = item.id
        setRows((prev) =>
          prev.map((row) =>
            row.id === id
              ? { ...row, loading: true, error: null, searchWarning: null }
              : row,
          ),
        )
        try {
          let queries: string[]
          let shotDesc: string | null = null
          let mustIn: string[] = []
          let avoidSubj: string[] = []
          try {
            const qRes = await raceAbort(
              withIpcTimeout(
                window.storyStock.generateVisualStockQueries({
                  chineseLine: item.text,
                  visualHintEn: item.visualHintEn ?? undefined,
                }),
                IPC_GENERATE_VISUAL_QUERIES_MS,
                '生成画面检索词（DashScope）',
              ),
              generationAbortRef,
            )
            queries = qRes.queries
            shotDesc = qRes.shotDescriptionEn || null
            mustIn = qRes.mustIncludeEn ?? []
            avoidSubj = qRes.avoidSubjectsEn ?? []
          } catch (e) {
            if (isGenerationAbortError(e)) throw e
            queries = [suggestStockSearchQuery(item.text)]
          }
          throwIfGenerationAborted(generationAbortRef)
          setRows((prev) =>
            prev.map((row) =>
              row.id === id
                ? {
                    ...row,
                    query: queries[0] ?? row.query,
                    queriesForSearch: queries,
                    aiShotDescriptionEn: shotDesc,
                    aiMustIncludeEn: mustIn,
                    aiAvoidSubjectsEn: avoidSubj,
                  }
                : row,
            ),
          )

          const searchRes = smart
            ? await raceAbort(
                withIpcTimeout(
                  window.storyStock.searchStockForSegment({
                    narrationZh: item.text,
                    queries,
                    shotDescriptionEn: shotDesc,
                    mustIncludeEn: mustIn,
                    avoidSubjectsEn: avoidSubj,
                  }),
                  IPC_STOCK_SEARCH_MS,
                  '搜索并排序素材',
                ),
                generationAbortRef,
              )
            : await raceAbort(
                withIpcTimeout(
                  window.storyStock.searchStockVideos(queries[0]),
                  IPC_STOCK_SEARCH_MS,
                  '搜索素材',
                ),
                generationAbortRef,
              )

          throwIfGenerationAborted(generationAbortRef)
          setRows((prev) => {
            const next = prev.map((row) =>
              row.id === id
                ? {
                    ...row,
                    loading: false,
                    videos: searchRes.videos ?? [],
                    selectedVideoKey:
                      (searchRes.videos ?? [])[0]?.key ?? null,
                    searchWarning:
                      searchRes.warnings.length > 0
                        ? searchRes.warnings.join(' · ')
                        : null,
                  }
                : row,
            )
            return resolveUniqueSelectionsWithOrder(next)
          })
        } catch (e) {
          if (isGenerationAbortError(e)) throw e
          const msg = e instanceof Error ? e.message : String(e)
          setRows((prev) =>
            prev.map((row) =>
              row.id === id ? { ...row, loading: false, error: msg } : row,
            ),
          )
        }
      })
    },
    [],
  )

  const runSegment = useCallback(async () => {
    generationAbortRef.current = false
    setPickerOpenForId(null)
    setGlobalError(null)
    const raw = story.trim()
    if (!raw) {
      setGlobalError('请先粘贴故事全文')
      return
    }

    const canLlm =
      apiReady && typeof window.storyStock.segmentForVoiceOver === 'function'

    setPipeline({ busy: true, label: '阿里云分段中…' })
    try {
      if (canLlm) {
        try {
          const part = await raceAbort(
            window.storyStock.segmentForVoiceOver(raw),
            generationAbortRef,
          )
          throwIfGenerationAborted(generationAbortRef)
          const parts = part.segments
          if (!parts.length) throw new Error('模型未返回任何片段')
          const built: SegmentRow[] = parts.map((text, id) => ({
            id,
            text,
            query: suggestStockSearchQuery(text),
            queriesForSearch: undefined,
            visualHintEn: part.visualHintsEn[id] ?? null,
            aiShotDescriptionEn: null,
      aiMustIncludeEn: undefined,
      aiAvoidSubjectsEn: undefined,
            videos: [],
            selectedVideoKey: null,
            loading: false,
            error: null,
            searchWarning: null,
          }))
          setRows(built)
          setPipeline({ busy: true, label: '生成检索词并拉取素材（多段并发，按匹配度排序）…' })
          await runMaterialsForAllRows(
            built.map((r) => ({
              id: r.id,
              text: r.text,
              visualHintEn: r.visualHintEn ?? null,
            })),
          )
        } catch (e) {
          if (isGenerationAbortError(e)) throw e
          const msg = e instanceof Error ? e.message : String(e)
          setGlobalError(`阿里云口播分段失败，已改用本地规则。原因：${msg}`)
          const lr = applyLocalSegment(story)
          throwIfGenerationAborted(generationAbortRef)
          setPipeline({ busy: true, label: '生成检索词并拉取素材（多段并发，按匹配度排序）…' })
          await runMaterialsForAllRows(
            lr.map((r) => ({
              id: r.id,
              text: r.text,
              visualHintEn: r.visualHintEn ?? null,
            })),
          )
        }
        return
      }

      const lr = applyLocalSegment(story)
      throwIfGenerationAborted(generationAbortRef)
      setPipeline({ busy: true, label: '生成检索词并拉取素材（多段并发，按匹配度排序）…' })
      await runMaterialsForAllRows(
        lr.map((r) => ({
          id: r.id,
          text: r.text,
          visualHintEn: r.visualHintEn ?? null,
        })),
      )
    } catch (e) {
      if (isGenerationAbortError(e)) {
        setRows((prev) => prev.map((row) => ({ ...row, loading: false })))
        setGlobalError('已暂停生成')
        return
      }
      throw e
    } finally {
      setPipeline({ busy: false, label: '' })
    }
  }, [apiReady, story, applyLocalSegment, runMaterialsForAllRows])

  const playDoubaoTts = useCallback(
    async (id: number, text: string) => {
      setTtsLoadingId(id)
      try {
        lastAudioRef.current?.pause()
        const speakerUse = ttsSpeakerManual.trim() || ttsSpeaker
        const { base64, mimeType } =
          await window.storyStock.synthesizeDoubaoTts({
            text,
            resourceId: ttsResourceId,
            speaker: speakerUse,
          })
        const audio = new Audio(`data:${mimeType};base64,${base64}`)
        lastAudioRef.current = audio
        await audio.play()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, error: msg } : r)),
        )
      } finally {
        setTtsLoadingId(null)
      }
    },
    [ttsResourceId, ttsSpeaker, ttsSpeakerManual],
  )

  const searchOne = useCallback(async (id: number) => {
    if (pipeline.busy) return
    const row = rowsRef.current.find((r) => r.id === id)
    if (!row) return

    const manual = row.query.trim()
    const queries =
      row.queriesForSearch && row.queriesForSearch.length > 0
        ? row.queriesForSearch.map((s) => s.trim()).filter(Boolean)
        : [manual].filter(Boolean)

    if (queries.length === 0) {
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, error: '请先填写检索词' } : r)),
      )
      return
    }

    setRows((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, loading: true, error: null, searchWarning: null }
          : r,
      ),
    )

    try {
      const smart =
        typeof window.storyStock.searchStockForSegment === 'function'
      const res = smart
        ? await withIpcTimeout(
            window.storyStock.searchStockForSegment({
              narrationZh: row.text,
              queries,
              shotDescriptionEn: row.aiShotDescriptionEn ?? null,
              mustIncludeEn: row.aiMustIncludeEn ?? [],
              avoidSubjectsEn: row.aiAvoidSubjectsEn ?? [],
            }),
            IPC_STOCK_SEARCH_MS,
            '搜索并排序素材',
          )
        : await withIpcTimeout(
            window.storyStock.searchStockVideos(queries[0]),
            IPC_STOCK_SEARCH_MS,
            '搜索素材',
          )
      setRows((prev) => {
        const next = prev.map((r) =>
          r.id === id
            ? {
                ...r,
                loading: false,
                videos: res.videos ?? [],
                selectedVideoKey: (res.videos ?? [])[0]?.key ?? null,
                searchWarning:
                  res.warnings.length > 0 ? res.warnings.join(' · ') : null,
              }
            : r,
        )
        return resolveUniqueSelectionsWithOrder(next)
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, loading: false, error: msg } : r)),
      )
    }
  }, [pipeline.busy])

  const runJimengVideo = useCallback(
    async (id: number) => {
      if (pipeline.busy) {
        setGlobalError(
          '「分段 / 拉素材」流程进行中，请结束后再试即梦 AI 视频。',
        )
        return
      }
      if (typeof window.storyStock.generateJimengSegmentVideo !== 'function') {
        const msg =
          '请使用桌面端（npm run dev / 打包版），浏览器预览不支持即梦 IPC。'
        setGlobalError(msg)
        setRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, error: msg } : r)),
        )
        return
      }
      const row = rowsRef.current.find((r) => r.id === id)
      if (!row) return
      const speakerUse = ttsSpeakerManual.trim() || ttsSpeaker
      setJimengLoadingId(id)
      setGlobalError(null)
      setJimengProgress({
        segmentIndex: id,
        percent: 2,
        label: '准备调用即梦…',
        detail:
          '需要豆包 TTS 与火山访问密钥；可在「密钥设置」中配置。',
      })
      const offProgress =
        window.storyStock.onJimengVideoProgress?.((p) => {
          if (p.segmentIndex === id) setJimengProgress(p)
        }) ?? (() => {})
      try {
        const res = await window.storyStock.generateJimengSegmentVideo({
          narrationZh: row.text,
          shotDescriptionEn: row.aiShotDescriptionEn ?? null,
          visualHintEn: row.visualHintEn ?? null,
          mustIncludeEn: row.aiMustIncludeEn,
          avoidSubjectsEn: row.aiAvoidSubjectsEn,
          stockQueriesEn: row.queriesForSearch,
          tts: { resourceId: ttsResourceId, speaker: speakerUse },
          segmentIndex: id,
        })
        setJimengProgress({
          segmentIndex: id,
          percent: 100,
          label: '已加入候选并排在首位',
          detail: `语音 ${res.voiceDurationSec.toFixed(1)}s · 生成档位 ${res.chosenGenDurationSec}s`,
        })
        setRows((prev) => {
          const next = prev.map((r) => {
            if (r.id !== id) return r
            const mergedVideos = [
              res.video,
              ...r.videos.filter((v) => v.key !== res.video.key),
            ]
            return {
              ...r,
              error: null,
              videos: mergedVideos,
              selectedVideoKey: res.video.key,
              searchWarning: `即梦 AI：本段语音约 ${res.voiceDurationSec.toFixed(1)}s，已选生成 ${res.chosenGenDurationSec}s 档位；导出时画面按语音时长裁剪。`,
            }
          })
          return resolveUniqueSelectionsWithOrder(next)
        })
        setPickerOpenForId(id)
        window.setTimeout(() => {
          setJimengProgress(null)
        }, 2200)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setGlobalError(msg)
        setJimengProgress({
          segmentIndex: id,
          percent: 0,
          label: '即梦生成失败',
          detail: msg.slice(0, 200),
        })
        setRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, error: msg } : r)),
        )
        window.setTimeout(() => setJimengProgress(null), 5000)
      } finally {
        offProgress()
        setJimengLoadingId(null)
      }
    },
    [pipeline.busy, ttsResourceId, ttsSpeaker, ttsSpeakerManual],
  )

  const searchAll = useCallback(async () => {
    if (pipeline.busy) return
    const snapshot = rowsRef.current
    if (snapshot.length === 0) return
    await mapPool(snapshot, stockSearchParallelism(), async (r) => {
      await searchOne(r.id)
    })
  }, [searchOne, pipeline.busy])

  const selectSegmentVideo = useCallback((id: number, key: string) => {
    setRows((prev) => {
      const next = prev.map((row) =>
        row.id === id ? { ...row, selectedVideoKey: key } : row,
      )
      return resolveUniqueSelectionsWithOrder(next)
    })
    setPickerOpenForId(null)
  }, [])

  const canExportNarrated = useMemo(() => {
    if (rows.length === 0) return false
    return rows.every((r) => {
      const v = r.videos.find((x) => x.key === r.selectedVideoKey)
      return !!(v?.previewVideoUrl?.trim())
    })
  }, [rows])

  const exportNarrated = useCallback(async () => {
    if (!exportReady || exportLoading) return
    const snapshot = rowsRef.current
    if (snapshot.length === 0) return
    for (const r of snapshot) {
      const v = r.videos.find((x) => x.key === r.selectedVideoKey)
      if (!v?.previewVideoUrl?.trim()) {
        setGlobalError(
          `请为每一段选中带预览视频的素材（第 ${r.id + 1} 段未满足）。`,
        )
        return
      }
    }
    setExportLoading(true)
    setGlobalError(null)
    setExportProgress({ percent: 0, label: '准备导出…' })
    const offProgress =
      window.storyStock.onExportVideoProgress?.((p) =>
        setExportProgress(p),
      ) ?? (() => {})
    try {
      const segments = snapshot.map((r) => {
        const v = r.videos.find((x) => x.key === r.selectedVideoKey)!
        return { narrationText: r.text, video: v }
      })
      const speakerUse = ttsSpeakerManual.trim() || ttsSpeaker
      const result = await window.storyStock.exportNarratedVideo({
        segments,
        tts: { resourceId: ttsResourceId, speaker: speakerUse },
      })
      if (result.canceled) return
      if ('outputPath' in result && result.outputPath) {
        await window.storyStock.showItemInFolder?.(result.outputPath)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setGlobalError(`导出失败：${msg}`)
    } finally {
      offProgress()
      setExportLoading(false)
      setExportProgress(null)
    }
  }, [
    exportLoading,
    exportReady,
    ttsResourceId,
    ttsSpeaker,
    ttsSpeakerManual,
  ])

  const exportJianyingPack = useCallback(async () => {
    if (!exportJianyingReady || jianyingExportLoading || exportLoading) return
    const snapshot = rowsRef.current
    if (snapshot.length === 0) return
    for (const r of snapshot) {
      const v = r.videos.find((x) => x.key === r.selectedVideoKey)
      if (!v?.previewVideoUrl?.trim()) {
        setGlobalError(
          `请为每一段选中带预览视频的素材（第 ${r.id + 1} 段未满足）。`,
        )
        return
      }
    }
    setJianyingExportLoading(true)
    setGlobalError(null)
    setJianyingExportProgress({ percent: 0, label: '准备导出剪映工程…' })
    const offProgress =
      window.storyStock.onJianyingExportProgress?.((p) =>
        setJianyingExportProgress(p),
      ) ?? (() => {})
    try {
      const segments = snapshot.map((r) => {
        const v = r.videos.find((x) => x.key === r.selectedVideoKey)!
        return { narrationText: r.text, video: v }
      })
      const speakerUse = ttsSpeakerManual.trim() || ttsSpeaker
      const result = await window.storyStock.exportJianyingProject({
        segments,
        tts: { resourceId: ttsResourceId, speaker: speakerUse },
      })
      if (result.canceled) return
      if ('outputPath' in result && result.outputPath) {
        await window.storyStock.showItemInFolder?.(result.outputPath)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setGlobalError(`导出剪映工程失败：${msg}`)
    } finally {
      offProgress()
      setJianyingExportLoading(false)
      setJianyingExportProgress(null)
    }
  }, [
    exportJianyingReady,
    exportLoading,
    jianyingExportLoading,
    ttsResourceId,
    ttsSpeaker,
    ttsSpeakerManual,
  ])

  const updateQuery = useCallback((id: number, query: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, query, queriesForSearch: undefined } : r,
      ),
    )
  }, [])

  const workflowBusy =
    pipeline.busy ||
    rows.some((r) => r.loading) ||
    exportLoading ||
    jianyingExportLoading ||
    jimengLoadingId !== null

  const packExportProgress = exportLoading ? exportProgress : jianyingExportProgress
  const packExportLoading = exportLoading || jianyingExportLoading

  if (authGate === 'boot') {
    return (
      <div className='auth-gate auth-gate--boot'>
        <p className='auth-boot-text'>正在验证登录状态…</p>
      </div>
    )
  }

  if (authGate === 'need') {
    return (
      <LoginScreen
        onLoggedIn={(u) => {
          setSessionUser(u)
          setAuthGate('ok')
        }}
      />
    )
  }

  const usageSyncAvailable =
    apiReady && typeof window.storyStock?.usageSyncStatus === 'function'

  if (usageSyncAvailable && usageGateLoading && !usageStatus) {
    return (
      <div className='auth-gate auth-gate--boot'>
        <p className='auth-boot-text'>正在校验可用天数…</p>
      </div>
    )
  }

  return (
    <div className='app-root'>
      <header className='app-header'>
        <div className='app-header-row'>
          <div className='brand'>
            <h1 className='brand-name'>易剪</h1>
            {usageSyncAvailable && usageStatus && (
              <span
                className='usage-badge'
                title='剩余可用天数与账户积分；1 积分可兑换 1 天'
              >
                剩余 {usageStatus.remainingDays} 天 · 积分{' '}
                {usageStatus.pointsBalance}
              </span>
            )}
          </div>
          <div className='app-header-actions'>
            {sessionUser?.email && (
              <span className='auth-session' title={sessionUser.email}>
                {sessionUser.email}
              </span>
            )}
            <button
              type='button'
              className='ghost'
              onClick={() => void logoutApp()}
            >
              退出登录
            </button>
            {apiReady && (
              <button
                type='button'
                className='ghost settings-trigger'
                onClick={() => {
                  setSettingsSavedHint(null)
                  setSettingsOpen(true)
                  void refreshSettingsView()
                }}
              >
                密钥设置
              </button>
            )}
            {!apiReady && (
              <span className='badge warn' title='完整功能需 Electron'>
                预览模式
              </span>
            )}
          </div>
        </div>
      </header>

      {usageSyncAvailable && usageStatus && !usageStatus.canUseApp && (
        <div className='usage-block-overlay' role='alertdialog' aria-modal='true'>
          <div className='usage-block-card'>
            <h2 className='usage-block-title'>可用天数不足</h2>
            <p className='usage-block-msg'>
              {usageStatus.blockMessage ??
                '当前无可用天数，请先兑换或充值积分后再试。'}
            </p>
            <p className='usage-block-msg'>
              剩余 <strong>{usageStatus.remainingDays}</strong> 天 · 积分{' '}
              <strong>{usageStatus.pointsBalance}</strong>
              {usageStatus.licenseApiOk && usageStatus.maxPurchasableDays > 0 && (
                <>
                  {' '}
                  · 最多可兑 <strong>{usageStatus.maxPurchasableDays}</strong> 天
                </>
              )}
            </p>
            {usageStatus.licenseApiOk && usageStatus.maxPurchasableDays > 0 && (
              <>
                <p className='usage-block-msg usage-block-msg--muted'>
                  输入要兑换的天数，点按钮即可（1 积分 = 1 天）。
                </p>
                <div className='usage-purchase-row'>
                <label className='usage-purchase-label' htmlFor='usage-purchase-days-input'>
                  兑换天数
                </label>
                <input
                  id='usage-purchase-days-input'
                  type='number'
                  className='usage-purchase-input'
                  min={1}
                  max={usageStatus.maxPurchasableDays}
                  value={purchaseDaysDraft}
                  onChange={(e) => setPurchaseDaysDraft(e.target.value)}
                  disabled={purchaseSubmitting}
                />
                <button
                  type='button'
                  disabled={purchaseSubmitting}
                  onClick={() => void tryPurchaseLicenseDays()}
                >
                  {purchaseSubmitting ? '兑换中…' : '用积分兑换可用天数'}
                </button>
                </div>
              </>
            )}
            {usageStatus.licenseApiOk &&
              usageStatus.maxPurchasableDays === 0 &&
              usageStatus.remainingDays === 0 &&
              usageStatus.pointsBalance === 0 && (
                <p className='usage-block-msg usage-block-msg--warn'>
                  积分为 0，请先到网站充值，再回此处兑换天数。
                </p>
              )}
            {purchaseErr && (
              <p className='usage-block-msg usage-block-msg--warn' role='alert'>
                {purchaseErr}
              </p>
            )}
            <div className='usage-block-actions'>
              <button type='button' onClick={() => openUsageAccountPage()}>
                前往购买积分
              </button>
              <button
                type='button'
                className='ghost'
                onClick={() => void logoutApp()}
              >
                退出登录
              </button>
            </div>
          </div>
        </div>
      )}

      {postLoginKeysGuide &&
        !(settingsView && apiKeysGuideSatisfied(settingsView)) && (
        <div className='keys-guide-banner' role='status'>
          <div className='keys-guide-banner-inner'>
            <p>
              请先配置阿里云、豆包配音（火山 TTS），以及至少一个素材站（Pexels 或
              Pixabay）。火山访问密钥为可选项：不配则无法使用 AI 文生视频（即梦），其余功能不受影响。请在「密钥设置」中填写并保存。
            </p>
            <div className='keys-guide-banner-actions'>
              <button
                type='button'
                className='ghost'
                onClick={() => void openKeysSetupDoc()}
              >
                查看密钥配置说明
              </button>
              {apiReady && (
                <button
                  type='button'
                  onClick={() => {
                    setSettingsSavedHint(null)
                    setSettingsOpen(true)
                    void refreshSettingsView()
                  }}
                >
                  去填写密钥
                </button>
              )}
              <button
                type='button'
                className='ghost'
                onClick={() => setPostLoginKeysGuide(false)}
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}

      <div className='layout'>
        <section className='panel story-panel'>
          <div className='panel-heading'>
            <h2 className='panel-title'>文稿</h2>
            <span className='panel-meta' aria-live='polite'>
              {story.trim().length} 字
            </span>
          </div>
          <label className='label visually-hidden' htmlFor='story'>
            故事全文
          </label>
          <textarea
            id='story'
            className='story-input'
            placeholder='粘贴正文…'
            value={story}
            onChange={(e) => setStory(e.target.value)}
            spellCheck={false}
          />
          <div className='row-actions'>
            <button
              type='button'
              onClick={() => void runSegment()}
              disabled={pipeline.busy}
            >
              {pipeline.busy
                ? pipeline.label || '处理中…'
                : '分段并匹配素材'}
            </button>
            {pipeline.busy && (
              <button
                type='button'
                className='ghost danger-outline'
                title='停止后续排队'
                onClick={() => {
                  generationAbortRef.current = true
                }}
              >
                暂停生成
              </button>
            )}
          </div>

          <div className='tts-toolbar'>
            <div className='tts-toolbar-title'>豆包配音</div>
            <div className='tts-toolbar-grid'>
              <label
                className='label tiny'
                title='须与火山控制台已开通的模型一致'
              >
                合成模型
              </label>
              <select
                className='tts-select'
                value={ttsResourceId}
                onChange={(e) => {
                  const id = e.target.value
                  setTtsResourceId(id)
                  const voices = voicesForResourceId(id)
                  setTtsSpeaker((prev) =>
                    voices.some((v) => v.speaker === prev)
                      ? prev
                      : voices[0]?.speaker ?? prev,
                  )
                }}
              >
                {DOUBAO_RESOURCE_PRESETS.map((r) => (
                  <option key={r.resourceId} value={r.resourceId}>
                    {r.label}
                  </option>
                ))}
              </select>
              <label className='label tiny'>音色模板</label>
              <select
                className='tts-select'
                value={ttsSpeakerSelectValue}
                onChange={(e) => setTtsSpeaker(e.target.value)}
              >
                {ttsVoiceList.map((v) => (
                  <option key={v.speaker} value={v.speaker}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>
            <label className='label tiny tts-custom-label' title='非空时覆盖下拉'>
              自定义 speaker
            </label>
            <input
              className='query-input tts-custom-input'
              value={ttsSpeakerManual}
              onChange={(e) => setTtsSpeakerManual(e.target.value)}
              placeholder='留空则使用上方下拉中的音色'
              spellCheck={false}
            />
            <p className='hint tight tts-doc-hint'>
              <a
                href='https://www.volcengine.com/docs/6561/1257544'
                target='_blank'
                rel='noreferrer'
              >
                完整音色列表（文档）
              </a>
            </p>
          </div>

          {globalError && <p className='error'>{globalError}</p>}
        </section>

        <section className='panel segments-panel'>
          <div className='segments-toolbar'>
            <div className='panel-heading segments-heading'>
              <h2 className='panel-title'>分段与素材</h2>
            </div>
            <div className='toolbar-btns'>
              {pipeline.busy && (
                <button
                  type='button'
                  className='ghost danger-outline'
                  title='停止后续排队'
                  onClick={() => {
                    generationAbortRef.current = true
                  }}
                >
                  暂停生成
                </button>
              )}
              {rows.length > 0 && (
                <>
                  <button
                    type='button'
                    className='primary-export'
                    onClick={() => void exportNarrated()}
                    disabled={
                      !exportReady ||
                      !canExportNarrated ||
                      exportLoading ||
                      jianyingExportLoading ||
                      pipeline.busy ||
                      rows.some((r) => r.loading)
                    }
                  >
                    {exportLoading ? '导出合成中…' : '导出解说成片'}
                  </button>
                  <button
                    type='button'
                    className='secondary'
                    title='剪映工程 ZIP（含分段视频、配音、字幕）'
                    onClick={() => void exportJianyingPack()}
                    disabled={
                      !exportJianyingReady ||
                      !canExportNarrated ||
                      jianyingExportLoading ||
                      exportLoading ||
                      pipeline.busy ||
                      rows.some((r) => r.loading)
                    }
                  >
                    {jianyingExportLoading ? '打包剪映工程…' : '导出剪映工程'}
                  </button>
                  <button
                    type='button'
                    className='secondary'
                    onClick={() => void searchAll()}
                    disabled={workflowBusy}
                  >
                    重新搜索全部素材
                  </button>
                </>
              )}
            </div>
          </div>

          {packExportLoading && packExportProgress && (
            <div
              className='export-progress-wrap'
              role='status'
              aria-live='polite'
            >
              <div className='export-progress-head'>
                <span className='export-progress-label'>
                  {packExportProgress.label}
                </span>
                <span className='export-progress-pct'>
                  {packExportProgress.percent}%
                </span>
              </div>
              {packExportProgress.detail && (
                <p className='export-progress-detail'>
                  {packExportProgress.detail}
                </p>
              )}
              <div className='export-progress-track'>
                <div
                  className='export-progress-fill'
                  style={{ width: `${packExportProgress.percent}%` }}
                />
              </div>
            </div>
          )}

          {rows.length === 0 && <p className='empty'>尚未生成分段。</p>}

          <ul className='segment-list'>
            {rows.map((r) => (
              <li key={r.id} className='segment-card'>
                <div className='segment-head'>
                  <span className='pill'>第 {r.id + 1} 段</span>
                  <span className='meta'>{r.text.length} 字</span>
                  <button
                    type='button'
                    className='ghost'
                    disabled={!apiReady || pipeline.busy || ttsLoadingId !== null}
                    onClick={() => playDoubaoTts(r.id, r.text)}
                  >
                    {ttsLoadingId === r.id ? '豆包合成中…' : '豆包配音'}
                  </button>
                  <button
                    type='button'
                    className='ghost'
                    onClick={() => speakTextBrowser(r.text, 'zh-CN')}
                  >
                    系统朗读
                  </button>
                </div>
                <div className='segment-narration-wrap'>
                  <p className='segment-body'>{r.text}</p>
                </div>

                <label className='label small'>检索词</label>
                {r.visualHintEn && (
                  <p className='hint tight'>
                    分段画面提示（英）：{r.visualHintEn}
                  </p>
                )}
                {r.aiShotDescriptionEn && (
                  <p className='hint tight'>
                    画面概括（英）：{r.aiShotDescriptionEn}
                  </p>
                )}
                <div className='query-row'>
                  <input
                    className='query-input'
                    value={r.query}
                    onChange={(e) => updateQuery(r.id, e.target.value)}
                    spellCheck={false}
                  />
                  <button
                    type='button'
                    onClick={() => void searchOne(r.id)}
                    disabled={r.loading || pipeline.busy}
                  >
                    {r.loading ? '搜索中…' : '重新搜索'}
                  </button>
                  <button
                    type='button'
                    className='ghost jimeng-btn'
                    title={
                      jimengLoadingId !== null && jimengLoadingId !== r.id
                        ? '其它段落生成中'
                        : '文生视频（需密钥）'
                    }
                    onClick={() => void runJimengVideo(r.id)}
                    disabled={
                      r.loading ||
                      pipeline.busy ||
                      jimengLoadingId !== null
                    }
                  >
                    {jimengLoadingId === r.id ? '即梦生成中…' : '即梦 AI 视频'}
                  </button>
                </div>
                {jimengProgress?.segmentIndex === r.id && (
                  <div className='jimeng-progress-wrap' role='status'>
                    <div className='jimeng-progress-head'>
                      <span className='jimeng-progress-label'>
                        {jimengProgress.label}
                      </span>
                      <span className='jimeng-progress-pct'>
                        {jimengProgress.percent}%
                      </span>
                    </div>
                    {(jimengProgress.voiceDurationSec != null ||
                      jimengProgress.targetGenDurationSec != null) && (
                      <p
                        className='jimeng-progress-meta'
                        title='成片时长按口播长度在本端选取最接近档位'
                      >
                        口播约{' '}
                        {jimengProgress.voiceDurationSec != null
                          ? `${jimengProgress.voiceDurationSec.toFixed(1)}s`
                          : '—'}
                        {' · 成片档位 '}
                        {jimengProgress.targetGenDurationSec != null
                          ? `${jimengProgress.targetGenDurationSec}s`
                          : '—'}
                      </p>
                    )}
                    {jimengProgress.serverStatusLabel && (
                      <p className='jimeng-progress-server'>
                        任务状态：{jimengProgress.serverStatusLabel}
                      </p>
                    )}
                    {jimengProgress.detail && (
                      <p className='jimeng-progress-detail'>
                        {jimengProgress.detail}
                      </p>
                    )}
                    <div className='jimeng-progress-track'>
                      <div
                        className='jimeng-progress-fill'
                        style={{ width: `${Math.min(100, jimengProgress.percent)}%` }}
                      />
                    </div>
                  </div>
                )}
                {r.error && <p className='error tight'>{r.error}</p>}
                {r.searchWarning && (
                  <p className='hint tight'>{r.searchWarning}</p>
                )}

                {r.videos.length > 0 && (() => {
                  const selectedClip = r.videos.find(
                    (v) => v.key === r.selectedVideoKey,
                  )
                  const showPicker = pickerOpenForId === r.id
                  const displayVideos = showPicker
                    ? r.videos.slice(
                        0,
                        Math.min(STOCK_UI_EXPAND_TOTAL, r.videos.length),
                      )
                    : r.videos.slice(0, 1)

                  return (
                  <>
                    <p className='hint tight video-sort-hint'>
                      各段成片素材互不重复；折叠时显示<strong>当前选用</strong>的一条（选用后会排到列表首位）。
                      点「另选素材」展开本段前 {STOCK_UI_EXPAND_TOTAL}{' '}
                      条高分候选；合并列表更长时其余条目不进预览。
                    </p>
                    <div className='video-picker-toolbar'>
                      <button
                        type='button'
                        className='ghost'
                        onClick={() =>
                          setPickerOpenForId(
                            pickerOpenForId === r.id ? null : r.id,
                          )
                        }
                      >
                        {showPicker
                          ? '收起，只看成片那条'
                          : '另选素材'}
                      </button>
                    </div>
                    {!showPicker &&
                      r.videos.length > 0 &&
                      !selectedClip && (
                        <p className='error tight'>
                          本段候选与其它段全部重复，请点「另选素材」或修改检索词后重新搜索。
                        </p>
                      )}
                    <ul className='video-grid'>
                    {displayVideos.map((v) => {
                      const vi = r.videos.findIndex((x) => x.key === v.key)
                      return (
                      <li
                        key={v.key}
                        className={`video-cell ${vi >= 0 && vi < 3 ? 'video-match-top' : ''} ${r.selectedVideoKey === v.key ? 'video-selected' : ''}`}
                        onClick={(e) => {
                          const el = e.target as HTMLElement
                          if (el.closest('video, a, button')) return
                          selectSegmentVideo(r.id, v.key)
                        }}
                      >
                        <div className='video-preview-page'>
                          <div className='video-preview-head'>
                            {vi >= 0 && vi < 5 && (
                              <span className='match-rank flat'>#{vi + 1}</span>
                            )}
                            <span className='video-preview-title'>素材预览</span>
                            <span className='src-badge inline'>
                              {v.source === 'pexels'
                                ? 'Pexels'
                                : v.source === 'pixabay'
                                  ? 'Pixabay'
                                  : v.source === 'jimeng'
                                    ? '即梦 AI'
                                    : 'Mixkit'}
                            </span>
                            <span className='dur inline'>
                              {v.duration > 0
                                ? `${Math.round(v.duration)}s`
                                : '—'}
                            </span>
                          </div>
                          {v.previewVideoUrl ? (
                            <StockPreviewVideo
                              video={v}
                              cacheRev={stockCacheRev}
                            />
                          ) : (
                            <div className='preview-fallback'>
                              <img
                                src={v.thumbnailUrl}
                                alt=''
                                className='thumb'
                              />
                              <p className='hint tight'>暂无预览流，请从原页查看。</p>
                            </div>
                          )}
                          <div className='video-preview-foot'>
                            <span
                              className='author'
                              title={v.authorName}
                            >
                              {v.authorName}
                            </span>
                            <button
                              type='button'
                              className='ghost pick-clip-btn'
                              onClick={(e) => {
                                e.stopPropagation()
                                selectSegmentVideo(r.id, v.key)
                              }}
                            >
                              {r.selectedVideoKey === v.key ? '已选用' : '选用'}
                            </button>
                            <a
                              className='link'
                              href={v.pageUrl}
                              target='_blank'
                              rel='noreferrer'
                              onClick={(e) => e.stopPropagation()}
                            >
                              浏览器打开原页
                            </a>
                          </div>
                        </div>
                      </li>
                    )
                    })}
                    </ul>
                  </>
                  )
                })()}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {settingsOpen && (
        <div
          className='settings-overlay'
          role='presentation'
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false)
          }}
        >
          <div
            className='settings-panel'
            role='dialog'
            aria-labelledby='settings-title'
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className='settings-panel-head'>
              <h2 id='settings-title'>密钥设置</h2>
              <button
                type='button'
                className='ghost'
                onClick={() => setSettingsOpen(false)}
              >
                关闭
              </button>
            </div>
            {settingsView && (
              <div className='settings-readiness' role='status'>
                {apiKeysGuideSatisfied(settingsView) ? (
                  <span className='settings-readiness-badge settings-readiness-badge--ok'>
                    必备项已就绪
                  </span>
                ) : (
                  <span className='settings-readiness-badge settings-readiness-badge--warn'>
                    必备项未齐
                  </span>
                )}
                {!settingsView.volcIamConfigured && (
                  <p className='settings-readiness-note'>
                    提示：未配置火山访问密钥时，无法使用 AI 文生视频（即梦）。
                  </p>
                )}
              </div>
            )}
            <div className='settings-intro settings-intro--doc'>
              <p className='meta settings-meta'>
                密钥保存在本机，每项单独保存。下方仅显示各 Key
                的前后若干位，中间已隐藏。详见
                <button
                  type='button'
                  className='link-like'
                  onClick={() => void openKeysSetupDoc()}
                >
                  密钥配置说明
                </button>
              </p>
            </div>
            {settingsSavedHint && (
              <p className='hint tight settings-saved'>{settingsSavedHint}</p>
            )}
            <div className='settings-section'>
              <h3>阿里云</h3>
              <p className='meta settings-meta'>
                文稿分段、检索词等依赖阿里云 DashScope。
              </p>
              {settingsView?.dashscopeConfigured && (
                <p className='meta settings-meta'>
                  当前生效：{settingsView.dashscopeApiKeyMasked}
                </p>
              )}
              <div className='settings-field'>
                <label className='settings-label' htmlFor='settings-dashscope-key'>
                  API Key
                </label>
                <div className='settings-input-row'>
                  <input
                    id='settings-dashscope-key'
                    className='query-input settings-input settings-input--grow'
                    type='password'
                    autoComplete='off'
                    placeholder='粘贴阿里云提供的 Key'
                    value={dashscopeKeyDraft}
                    onChange={(e) => setDashscopeKeyDraft(e.target.value)}
                  />
                  <button type='button' onClick={() => void saveDashscopeKey()}>
                    保存
                  </button>
                  {settingsView?.dashscopeSavedInSettings && (
                    <button
                      type='button'
                      className='ghost tiny-clear'
                      onClick={() => void clearUserApiField('dashscopeApiKey')}
                    >
                      清除
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className='settings-section'>
              <h3>视频素材（Pexels / Pixabay）</h3>
              <p className='meta settings-meta'>
                检索免版权视频，至少配置一项。
              </p>
              {settingsView?.pexelsConfigured && (
                <p className='meta settings-meta'>
                  Pexels 当前生效：{settingsView.pexelsApiKeyMasked}
                </p>
              )}
              {settingsView?.pixabayConfigured && (
                <p className='meta settings-meta'>
                  Pixabay 当前生效：{settingsView.pixabayApiKeyMasked}
                </p>
              )}
              <div className='settings-field-stack'>
                <div className='settings-field'>
                  <label className='settings-label' htmlFor='settings-pexels-key'>
                    Pexels API Key
                  </label>
                  <div className='settings-input-row'>
                    <input
                      id='settings-pexels-key'
                      className='query-input settings-input settings-input--grow'
                      type='password'
                      autoComplete='off'
                      placeholder='粘贴 Pexels Key'
                      value={pexelsKeyDraft}
                      onChange={(e) => setPexelsKeyDraft(e.target.value)}
                    />
                    <button type='button' onClick={() => void savePexelsKey()}>
                      保存
                    </button>
                    {settingsView?.pexelsSavedInSettings && (
                      <button
                        type='button'
                        className='ghost tiny-clear'
                        onClick={() => void clearUserApiField('pexelsApiKey')}
                      >
                        清除
                      </button>
                    )}
                  </div>
                </div>
                <div className='settings-field'>
                  <label
                    className='settings-label'
                    htmlFor='settings-pixabay-key'
                  >
                    Pixabay API Key
                  </label>
                  <div className='settings-input-row'>
                    <input
                      id='settings-pixabay-key'
                      className='query-input settings-input settings-input--grow'
                      type='password'
                      autoComplete='off'
                      placeholder='粘贴 Pixabay Key'
                      value={pixabayKeyDraft}
                      onChange={(e) => setPixabayKeyDraft(e.target.value)}
                    />
                    <button type='button' onClick={() => void savePixabayKey()}>
                      保存
                    </button>
                    {settingsView?.pixabaySavedInSettings && (
                      <button
                        type='button'
                        className='ghost tiny-clear'
                        onClick={() => void clearUserApiField('pixabayApiKey')}
                      >
                        清除
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className='settings-section'>
              <h3>豆包配音（火山 TTS）</h3>
              {settingsView?.volcTtsConfigured && (
                <p className='meta settings-meta'>
                  当前生效：{settingsView.volcTtsApiKeyMasked}
                </p>
              )}
              <div className='settings-field'>
                <label className='settings-label' htmlFor='settings-volc-tts-key'>
                  API Key
                </label>
                <div className='settings-input-row'>
                  <input
                    id='settings-volc-tts-key'
                    className='query-input settings-input settings-input--grow'
                    type='password'
                    autoComplete='off'
                    placeholder='粘贴豆包 / 火山语音侧提供的 Key'
                    value={volcTtsKeyDraft}
                    onChange={(e) => setVolcTtsKeyDraft(e.target.value)}
                  />
                  <button type='button' onClick={() => void saveVolcTtsKey()}>
                    保存
                  </button>
                  {settingsView?.volcTtsSavedInSettings && (
                    <button
                      type='button'
                      className='ghost tiny-clear'
                      onClick={() => void clearUserApiField('volcTtsApiKey')}
                    >
                      清除
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className='settings-section'>
              <h3>火山访问密钥（可选 · AI 文生视频）</h3>
              <p className='meta settings-meta'>
                用于即梦等 AI 文生视频。不配此项将无法生成 AI 视频；配音、分段与素材检索不受影响。
              </p>
              {(settingsView?.volcIamConfigured ?? false) && (
                <p className='meta settings-meta'>
                  当前生效：Access Key {settingsView?.volcAccessKeyIdMasked}{' '}
                  · Secret {settingsView?.volcSecretAccessKeyMasked}
                </p>
              )}
              <div className='settings-field-stack'>
                <div className='settings-field'>
                  <label className='settings-label' htmlFor='settings-volc-ak'>
                    Access Key ID
                  </label>
                  <input
                    id='settings-volc-ak'
                    className='query-input settings-input'
                    type='password'
                    autoComplete='off'
                    placeholder='粘贴 Access Key ID'
                    value={volcAkDraft}
                    onChange={(e) => setVolcAkDraft(e.target.value)}
                  />
                </div>
                <div className='settings-field'>
                  <label className='settings-label' htmlFor='settings-volc-sk'>
                    Secret Access Key
                  </label>
                  <input
                    id='settings-volc-sk'
                    className='query-input settings-input'
                    type='password'
                    autoComplete='off'
                    placeholder='粘贴 Secret Access Key'
                    value={volcSkDraft}
                    onChange={(e) => setVolcSkDraft(e.target.value)}
                  />
                </div>
              </div>
              <div className='settings-volc-iam-actions'>
                <button type='button' onClick={() => void saveVolcIamKeys()}>
                  保存两项
                </button>
                {(settingsView?.volcIamSavedInSettings ?? false) && (
                  <button
                    type='button'
                    className='ghost tiny-clear'
                    onClick={() => void clearVolcIamPair()}
                  >
                    清除两项
                  </button>
                )}
              </div>
            </div>
            <div className='settings-actions'>
              <button type='button' onClick={() => setSettingsOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
