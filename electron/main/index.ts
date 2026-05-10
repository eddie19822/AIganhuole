import {
  app,
  BrowserWindow,
  dialog,
  shell,
  ipcMain,
  net,
  protocol,
  session,
} from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs, { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import dotenv from 'dotenv'
import { update } from './update'
import {
  hybridReorderStockVideos,
  searchMergedDedupe,
  searchPexelsAndPixabay,
  stockItemsPerSource,
} from './stockSearch'
import {
  generateVisualStockQueriesFromChinese,
  rerankStockVideosByNarration,
  segmentForVoiceOver,
} from './dashscope'
import { synthesizeDoubaoTtsMp3Base64 } from './doubaoTts'
import { exportNarratedVideoFile } from './exportVideo'
import { exportJianyingProjectZip } from './exportJianyingProject'
import {
  clampStockCachePrefetchConcurrency,
  ensureStockVideoFullThenInvalidatePreview,
  isPathUnderStockVideoCache,
  prefetchStockVideosTiered,
  prefetchStockVideosToCache,
  resolveStockVideoPlayUrl,
} from './stockVideoCache'
import { generateJimengSegmentVideo } from './arkJimengVideo'
import type { UnifiedStockVideo } from '../../src/types/stockVideo'
import type { UserApiSettingsPatch } from '../../src/types/userApiSettings'
import {
  effectiveDashscopeApiKey,
  effectivePixabayApiKey,
  effectivePexelsApiKey,
  effectiveVolcTtsApiKey,
  getUserApiSettingsPublic,
} from './userApiKeys'
import { writeUserApiSettings } from './userApiSettings'
import {
  authApiBase,
  getAuthStatePublic,
  loginWithPassword,
  logout,
} from './authSession'
import {
  assertActiveUsageOrThrow,
  invalidateUsageAssertCache,
  maybeFirstLoginAutoRedeemSevenDays,
  purchaseLicenseDays,
  syncUsageAccess,
} from './usageAccess'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 开发/打包后 cwd 可能不是项目根，多路径尝试加载 .env */
function loadDotEnv(): void {
  const candidates = [
    path.join(__dirname, '../../.env'),
    path.join(__dirname, '../.env'),
    path.join(process.cwd(), '.env'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p })
      return
    }
  }
  dotenv.config()
}
loadDotEnv()

/**
 * 火山 TOS / 相关 CDN 对主进程代拉、直连播放常校验 Referer；对 session 内请求统一补上，
 * 这样渲染进程可用原生 https + Range（视频分片），避免仅传 Referer 时丢 Range 导致黑屏。
 */
function setupVolcengineCdnRequestHeaders(): void {
  const urls = [
    '*://*.volces.com/*',
    '*://*.volcengine.com/*',
    '*://*.volcengineapi.com/*',
    '*://*.byteimg.com/*',
    '*://*.bytecdn.cn/*',
    '*://*.pstatp.com/*',
    '*://*.snssdk.com/*',
  ]
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    const requestHeaders = {
      ...details.requestHeaders,
      Referer: 'https://www.volcengine.com/',
      Origin: 'https://www.volcengine.com',
    }
    callback({ requestHeaders })
  })
}

/** 备用：自定义协议代拉时必须转发原请求的 Range 等头，否则 <video> 无法解码 */
/** 即梦成片缓存到 tmp 后由此协议在本进程内串流给 <video>（Range 由可读流整段提供） */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'story-video',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: 'jimeng-local',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: 'stock-cache',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// Disable GPU Acceleration for Windows 7
if (os.release().startsWith('6.1')) app.disableHardwareAcceleration()

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

async function createWindow() {
  win = new BrowserWindow({
    title: '易剪',
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    webPreferences: {
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // nodeIntegration: true,

      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      // contextIsolation: false,
    },
  })

  if (VITE_DEV_SERVER_URL) { // #298
    win.loadURL(VITE_DEV_SERVER_URL)
    if (process.env.VSCODE_DEBUG === 'true') win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }

  // Test actively push message to the Electron-Renderer
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Auto update
  update(win)
}

app.whenReady().then(() => {
  setupVolcengineCdnRequestHeaders()

  protocol.handle('story-video', async (request) => {
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    if (parsed.hostname !== 'cdn' || !parsed.pathname.startsWith('/open')) {
      return new Response('not found', { status: 404 })
    }
    const target = parsed.searchParams.get('u')
    if (!target?.startsWith('https://')) {
      return new Response('bad target', { status: 400 })
    }
    try {
      const h = new Headers(request.headers)
      h.set('Referer', 'https://www.volcengine.com/')
      h.set('Origin', 'https://www.volcengine.com')
      return await net.fetch(target, {
        method: request.method,
        headers: h,
        body:
          request.method !== 'GET' && request.method !== 'HEAD'
            ? request.body
            : undefined,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(msg, { status: 502 })
    }
  })

  protocol.handle('stock-cache', async (request) => {
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    const t = parsed.searchParams.get('t')
    if (!t) return new Response('missing t', { status: 400 })
    let fsPath: string
    try {
      fsPath = Buffer.from(decodeURIComponent(t), 'base64url').toString('utf8')
    } catch {
      return new Response('bad encoding', { status: 400 })
    }
    const norm = path.normalize(fsPath)
    if (!isPathUnderStockVideoCache(norm)) {
      return new Response('forbidden', { status: 403 })
    }
    if (!fs.existsSync(norm)) return new Response('not found', { status: 404 })
    try {
      const st = fs.statSync(norm)
      const size = st.size
      const range = request.headers.get('range')
      if (request.method === 'HEAD') {
        return new Response(null, {
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=3600',
          },
        })
      }
      if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range)
        if (m) {
          const start = parseInt(m[1], 10)
          let end = m[2] ? parseInt(m[2], 10) : size - 1
          if (Number.isNaN(start) || start >= size) {
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${size}` },
            })
          }
          end = Math.min(end, size - 1)
          if (start > end) {
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${size}` },
            })
          }
          const nodeStream = createReadStream(norm, { start, end })
          const webStream = Readable.toWeb(nodeStream)
          return new Response(webStream as unknown as BodyInit, {
            status: 206,
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${size}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, max-age=3600',
            },
          })
        }
      }
      const nodeStream = createReadStream(norm)
      const webStream = Readable.toWeb(nodeStream)
      return new Response(webStream as unknown as BodyInit, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
        },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(msg, { status: 500 })
    }
  })

  protocol.handle('jimeng-local', async (request) => {
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    const t = parsed.searchParams.get('t')
    if (!t) return new Response('missing t', { status: 400 })
    let fsPath: string
    try {
      fsPath = Buffer.from(t, 'base64url').toString('utf8')
    } catch {
      return new Response('bad encoding', { status: 400 })
    }
    const norm = path.normalize(fsPath)
    const tmpRoot = path.normalize(os.tmpdir())
    const inTmp =
      process.platform === 'win32'
        ? norm.toLowerCase().startsWith(tmpRoot.toLowerCase())
        : norm.startsWith(tmpRoot)
    if (!inTmp || !norm.includes('story-stock-jimeng-preview-')) {
      return new Response('forbidden', { status: 403 })
    }
    if (!fs.existsSync(norm)) return new Response('not found', { status: 404 })
    try {
      const st = fs.statSync(norm)
      const nodeStream = createReadStream(norm)
      const webStream = Readable.toWeb(nodeStream)
      return new Response(webStream as unknown as BodyInit, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(st.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
        },
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(msg, { status: 500 })
    }
  })

  void createWindow()
})

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})

ipcMain.handle(
  'auth-login',
  async (_, payload: { email?: string; password?: string }) => {
    const email = String(payload?.email ?? '')
    const password = String(payload?.password ?? '')
    const user = await loginWithPassword(email, password)
    invalidateUsageAssertCache()
    await maybeFirstLoginAutoRedeemSevenDays()
    return user
  },
)

ipcMain.handle('auth-logout', () => {
  invalidateUsageAssertCache()
  logout()
})

ipcMain.handle('auth-get-state', async () => getAuthStatePublic())

/** 试用 / 积分 / 当日使用权（登录后由渲染进程拉取展示） */
ipcMain.handle('usage-sync-status', async () => syncUsageAccess())

ipcMain.handle('usage-purchase-days', async (_, days: unknown) => {
  const n = typeof days === 'number' ? days : Number(days)
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      message: '兑换天数参数无效',
    }
  }
  return purchaseLicenseDays(n)
})

/** 登录页「注册」：打开站点（未登录也可调用）。可用 AUTH_REGISTER_URL 覆盖完整 URL。 */
ipcMain.handle('open-auth-register-page', async () => {
  const fromEnv = process.env.AUTH_REGISTER_URL?.trim()
  let target: string
  if (fromEnv && /^https:\/\//i.test(fromEnv)) {
    target = fromEnv
  } else {
    const origin = new URL(authApiBase()).origin
    target = `${origin}/register`
  }
  await shell.openExternal(target)
})

/** 在系统浏览器中打开 https 链接（如飞书密钥说明文档） */
ipcMain.handle('open-external-url', async (_, url: unknown) => {
  const s = typeof url === 'string' ? url.trim() : ''
  if (!/^https:\/\//i.test(s)) {
    throw new Error('仅支持 https 链接')
  }
  await shell.openExternal(s)
})

ipcMain.handle('user-api-settings-get', async () => {
  await assertActiveUsageOrThrow()
  return getUserApiSettingsPublic()
})

ipcMain.handle(
  'user-api-settings-set',
  async (_, patch: UserApiSettingsPatch) => {
    await assertActiveUsageOrThrow()
    writeUserApiSettings(patch ?? {})
    return getUserApiSettingsPublic()
  },
)

ipcMain.handle('stock-search-videos', async (_, query: string) => {
  await assertActiveUsageOrThrow()
  const pexelsKey = effectivePexelsApiKey()
  const pixabayKey = effectivePixabayApiKey()
  return searchPexelsAndPixabay({
    pexelsKey,
    pixabayKey,
    query: String(query ?? ''),
    perSource: stockItemsPerSource(),
  })
})

/** 后台把候选成片 URL 下载到 userData/stock-video-cache，导出时优先走本地复制 */
ipcMain.handle(
  'stock-prefetch-video-cache',
  async (
    _,
    payload: { videos: UnifiedStockVideo[]; concurrency?: number },
  ) => {
    await assertActiveUsageOrThrow()
    const videos = Array.isArray(payload?.videos) ? payload.videos : []
    const requested =
      typeof payload?.concurrency === 'number' &&
      Number.isFinite(payload.concurrency)
        ? Math.floor(payload.concurrency)
        : 8
    const c = clampStockCachePrefetchConcurrency(requested)
    await prefetchStockVideosToCache(videos, c)
  },
)

/** 选中项完整缓存 + 候选仅前缀预览；导出时选中条可走本地整文件 */
ipcMain.handle(
  'stock-prefetch-video-cache-tiered',
  async (
    _,
    payload: {
      fullVideos?: UnifiedStockVideo[]
      previewVideos?: UnifiedStockVideo[]
      concurrencyFull?: number
      concurrencyPreview?: number
    },
  ) => {
    await assertActiveUsageOrThrow()
    const fullVideos = Array.isArray(payload?.fullVideos)
      ? payload.fullVideos
      : []
    const previewVideos = Array.isArray(payload?.previewVideos)
      ? payload.previewVideos
      : []
    await prefetchStockVideosTiered({
      fullVideos,
      previewVideos,
      concurrencyFull: payload?.concurrencyFull,
      concurrencyPreview: payload?.concurrencyPreview,
    })
  },
)

ipcMain.handle(
  'stock-cache-resolve-play-url',
  async (_event, video: UnifiedStockVideo) => {
    await assertActiveUsageOrThrow()
    return resolveStockVideoPlayUrl(video ?? ({} as UnifiedStockVideo))
  },
)

ipcMain.handle(
  'stock-cache-ensure-full',
  async (_event, video: UnifiedStockVideo) => {
    await assertActiveUsageOrThrow()
    await ensureStockVideoFullThenInvalidatePreview(video ?? ({} as UnifiedStockVideo))
    return resolveStockVideoPlayUrl(video ?? ({} as UnifiedStockVideo))
  },
)

ipcMain.handle('dashscope-segment-voiceover', async (_, fullText: string) => {
  await assertActiveUsageOrThrow()
  const key = effectiveDashscopeApiKey()
  if (!key) {
    throw new Error(
      '缺少阿里云 DashScope API Key：请在「密钥设置」中填写。',
    )
  }
  return segmentForVoiceOver({
    apiKey: key,
    fullText: String(fullText ?? ''),
  })
})

ipcMain.handle(
  'dashscope-visual-stock-queries',
  async (
    _,
    payload: { chineseLine: string; visualHintEn?: string | null },
  ) => {
    await assertActiveUsageOrThrow()
    const key = effectiveDashscopeApiKey()
    if (!key) {
      throw new Error(
        '缺少阿里云 DashScope API Key：请在「密钥设置」中填写。',
      )
    }
    return generateVisualStockQueriesFromChinese({
      apiKey: key,
      chineseLine: String(payload?.chineseLine ?? ''),
      visualHintEn: payload?.visualHintEn,
    })
  },
)

ipcMain.handle(
  'stock-search-smart',
  async (
    _,
    payload: {
      narrationZh: string
      queries: string[]
      shotDescriptionEn?: string | null
      mustIncludeEn?: string[]
      avoidSubjectsEn?: string[]
    },
  ) => {
    await assertActiveUsageOrThrow()
    const pexelsKey = effectivePexelsApiKey()
    const pixabayKey = effectivePixabayApiKey()
    const narrationZh = String(payload?.narrationZh ?? '')
    const queries = Array.isArray(payload?.queries)
      ? payload.queries.map((q) => String(q ?? ''))
      : []
    const shotDescriptionEn =
      typeof payload?.shotDescriptionEn === 'string'
        ? payload.shotDescriptionEn
        : null
    const mustIncludeEn = Array.isArray(payload?.mustIncludeEn)
      ? payload.mustIncludeEn.map((x) => String(x ?? ''))
      : []
    const avoidSubjectsEn = Array.isArray(payload?.avoidSubjectsEn)
      ? payload.avoidSubjectsEn.map((x) => String(x ?? ''))
      : []

    let merged = await searchMergedDedupe({
      pexelsKey,
      pixabayKey,
      queries,
      perQueryPerSource: stockItemsPerSource(),
    })

    const englishParts = [
      ...(shotDescriptionEn?.trim() ? [shotDescriptionEn.trim()] : []),
      ...queries.map((q) => q.trim()).filter(Boolean),
    ]
    const keywordBoostOn =
      process.env.STOCK_ENGLISH_KEYWORD_BOOST_ENABLED !== 'false'
    const embedOn = process.env.DASHSCOPE_EMBEDDING_ENABLED !== 'false'
    const hasAnchors = mustIncludeEn.some((s) => s.trim()) ||
      avoidSubjectsEn.some((s) => s.trim())
    if (
      merged.videos.length > 1 &&
      (keywordBoostOn || embedOn || hasAnchors || englishParts.length > 0)
    ) {
      const key = effectiveDashscopeApiKey()
      merged = {
        ...merged,
        videos: await hybridReorderStockVideos(merged.videos, {
          apiKey: key,
          narrationZh,
          shotDescriptionEn,
          queries: queries.filter((q) => q.trim()),
          englishParts,
          mustIncludeEn,
          avoidSubjectsEn,
        }),
      }
    }

    const rerankOn = process.env.DASHSCOPE_RERANK_ENABLED !== 'false'
    const key = effectiveDashscopeApiKey()
    if (rerankOn && key && merged.videos.length > 1 && narrationZh.trim()) {
      const videos = await rerankStockVideosByNarration({
        apiKey: key,
        narrationZh,
        candidates: merged.videos,
        englishShotDescription: shotDescriptionEn,
        englishQueries: queries.filter((q) => q.trim()),
        mustIncludeEn,
        avoidSubjectsEn,
      })
      return { videos, warnings: merged.warnings }
    }
    return merged
  },
)

ipcMain.handle('doubao-tts-env-defaults', async () => {
  await assertActiveUsageOrThrow()
  return {
    resourceId:
      process.env.VOLC_TTS_RESOURCE_ID?.trim() || 'seed-tts-1.0',
    speaker:
      process.env.VOLC_TTS_SPEAKER?.trim() ||
      process.env.VOLC_TTS_VOICE_TYPE?.trim() ||
      'zh_female_shuangkuaisisi_moon_bigtts',
  }
})

ipcMain.handle(
  'jimeng-generate-segment-video',
  async (
    event,
    payload: {
      narrationZh: string
      shotDescriptionEn?: string | null
      visualHintEn?: string | null
      mustIncludeEn?: string[]
      avoidSubjectsEn?: string[]
      stockQueriesEn?: string[]
      tts: { resourceId: string; speaker: string }
      segmentIndex?: number
    },
  ) => {
    await assertActiveUsageOrThrow()
    const ttsKey = effectiveVolcTtsApiKey()
    if (!ttsKey) {
      throw new Error(
        '缺少豆包 TTS API Key：请在「密钥设置」中填写（即梦流程需要配音测时长）。',
      )
    }
    const segmentIndex =
      typeof payload?.segmentIndex === 'number' ? payload.segmentIndex : -1
    const sendProgress = (p: {
      percent: number
      label: string
      detail?: string
    }) => {
      event.sender.send('jimeng-video-progress', {
        segmentIndex,
        ...p,
      })
    }
    return generateJimengSegmentVideo({
      narrationZh: String(payload?.narrationZh ?? ''),
      shotDescriptionEn: payload?.shotDescriptionEn ?? null,
      visualHintEn: payload?.visualHintEn ?? null,
      mustIncludeEn: payload?.mustIncludeEn,
      avoidSubjectsEn: payload?.avoidSubjectsEn,
      stockQueriesEn: payload?.stockQueriesEn,
      ttsApiKey: ttsKey,
      ttsResourceId: String(payload?.tts?.resourceId ?? '').trim() || 'seed-tts-1.0',
      ttsSpeaker: String(payload?.tts?.speaker ?? '').trim() || 'zh_female_shuangkuaisisi_moon_bigtts',
      onProgress: sendProgress,
    })
  },
)

ipcMain.handle(
  'doubao-tts',
  async (
    _,
    payload:
      | string
      | {
          text: string
          resourceId?: string
          speaker?: string
        },
  ) => {
    await assertActiveUsageOrThrow()
    const apiKey = effectiveVolcTtsApiKey()
    if (!apiKey) {
      throw new Error(
        '缺少豆包 TTS API Key：请在「密钥设置」中填写。',
      )
    }

    const text =
      typeof payload === 'string'
        ? String(payload ?? '')
        : String(payload?.text ?? '')

    const envResource =
      process.env.VOLC_TTS_RESOURCE_ID?.trim() || 'seed-tts-1.0'
    const envSpeaker =
      process.env.VOLC_TTS_SPEAKER?.trim() ||
      process.env.VOLC_TTS_VOICE_TYPE?.trim() ||
      'zh_female_shuangkuaisisi_moon_bigtts'

    const resourceId =
      typeof payload === 'object' && payload?.resourceId?.trim()
        ? payload.resourceId.trim()
        : envResource
    const speaker =
      typeof payload === 'object' && payload?.speaker?.trim()
        ? payload.speaker.trim()
        : envSpeaker

    const base64 = await synthesizeDoubaoTtsMp3Base64({
      apiKey,
      resourceId,
      speaker,
      text,
    })
    return { mimeType: 'audio/mpeg' as const, base64 }
  },
)

ipcMain.handle(
  'export-narrated-video',
  async (
    event,
    payload: {
      segments: Array<{ narrationText: string; video: UnifiedStockVideo }>
      tts: { resourceId: string; speaker: string }
    },
  ) => {
    await assertActiveUsageOrThrow()
    const apiKey = effectiveVolcTtsApiKey()
    if (!apiKey) {
      throw new Error(
        '缺少豆包 TTS API Key：请在「密钥设置」中填写。',
      )
    }

    const win = BrowserWindow.fromWebContents(event.sender)
    const saveOpts = {
      title: '导出解说成片',
      defaultPath: path.join(
        app.getPath('documents'),
        'story-stock-narrated.mp4',
      ),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    }
    const { filePath, canceled } = win
      ? await dialog.showSaveDialog(win, saveOpts)
      : await dialog.showSaveDialog(saveOpts)
    if (canceled || !filePath) {
      return { canceled: true as const }
    }

    const resourceId =
      process.env.VOLC_TTS_RESOURCE_ID?.trim() || 'seed-tts-1.0'
    const envSpeaker =
      process.env.VOLC_TTS_SPEAKER?.trim() ||
      process.env.VOLC_TTS_VOICE_TYPE?.trim() ||
      'zh_female_shuangkuaisisi_moon_bigtts'

    await exportNarratedVideoFile({
      segments: payload.segments,
      ttsApiKey: apiKey,
      ttsResourceId: payload.tts.resourceId?.trim() || resourceId,
      ttsSpeaker: payload.tts.speaker?.trim() || envSpeaker,
      outputFile: filePath,
      onProgress: (ev) => {
        const w = event.sender
        if (!w.isDestroyed()) w.send('export-video-progress', ev)
      },
    })
    return { canceled: false as const, outputPath: filePath }
  },
)

ipcMain.handle(
  'export-jianying-project',
  async (
    event,
    payload: {
      segments: Array<{ narrationText: string; video: UnifiedStockVideo }>
      tts: { resourceId: string; speaker: string }
    },
  ) => {
    await assertActiveUsageOrThrow()
    const apiKey = effectiveVolcTtsApiKey()
    if (!apiKey) {
      throw new Error(
        '缺少豆包 TTS API Key：请在「密钥设置」中填写。',
      )
    }

    const win = BrowserWindow.fromWebContents(event.sender)
    const saveOpts = {
      title: '导出剪映工程（ZIP）',
      defaultPath: path.join(
        app.getPath('documents'),
        '易剪-剪映工程.zip',
      ),
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    }
    const { filePath, canceled } = win
      ? await dialog.showSaveDialog(win, saveOpts)
      : await dialog.showSaveDialog(saveOpts)
    if (canceled || !filePath) {
      return { canceled: true as const }
    }

    const resourceId =
      process.env.VOLC_TTS_RESOURCE_ID?.trim() || 'seed-tts-1.0'
    const envSpeaker =
      process.env.VOLC_TTS_SPEAKER?.trim() ||
      process.env.VOLC_TTS_VOICE_TYPE?.trim() ||
      'zh_female_shuangkuaisisi_moon_bigtts'

    await exportJianyingProjectZip({
      segments: payload.segments,
      ttsApiKey: apiKey,
      ttsResourceId: payload.tts.resourceId?.trim() || resourceId,
      ttsSpeaker: payload.tts.speaker?.trim() || envSpeaker,
      outputZipPath: filePath,
      onProgress: (ev) => {
        const w = event.sender
        if (!w.isDestroyed()) w.send('jianying-export-progress', ev)
      },
    })
    return { canceled: false as const, outputPath: filePath }
  },
)

ipcMain.handle('show-item-in-folder', async (_, fullPath: string) => {
  await assertActiveUsageOrThrow()
  const p = path.normalize(String(fullPath ?? ''))
  if (p) shell.showItemInFolder(p)
})

// New window example arg: new windows url
ipcMain.handle('open-win', async (_, arg) => {
  await assertActiveUsageOrThrow()
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`)
  } else {
    childWindow.loadFile(indexHtml, { hash: arg })
  }
})
