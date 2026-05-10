import { ipcRenderer, contextBridge } from 'electron'
import type { UnifiedStockVideo } from '../../src/types/stockVideo'
import type { ExportVideoProgress } from '../../src/types/exportVideo'
import type { JimengVideoProgress } from '../../src/types/jimengVideo'
import type {
  UserApiSettingsPatch,
  UserApiSettingsPublic,
} from '../../src/types/userApiSettings'
import type { AuthUser } from '../../src/types/auth'
import type {
  UsagePublicStatus,
  UsagePurchaseDaysResult,
} from '../../src/types/usage'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('storyStock', {
  usageSyncStatus: () =>
    ipcRenderer.invoke('usage-sync-status') as Promise<UsagePublicStatus>,
  usagePurchaseDays: (days: number) =>
    ipcRenderer.invoke('usage-purchase-days', days) as Promise<UsagePurchaseDaysResult>,
  authLogin: (payload: { email: string; password: string }) =>
    ipcRenderer.invoke('auth-login', payload) as Promise<AuthUser>,
  authLogout: () => ipcRenderer.invoke('auth-logout') as Promise<void>,
  authGetState: () =>
    ipcRenderer.invoke('auth-get-state') as Promise<{
      loggedIn: boolean
      user?: AuthUser
    }>,
  openAuthRegisterPage: () =>
    ipcRenderer.invoke('open-auth-register-page') as Promise<void>,
  openExternalUrl: (url: string) =>
    ipcRenderer.invoke('open-external-url', url) as Promise<void>,
  getUserApiSettings: () =>
    ipcRenderer.invoke(
      'user-api-settings-get',
    ) as Promise<UserApiSettingsPublic>,
  setUserApiSettings: (patch: UserApiSettingsPatch) =>
    ipcRenderer.invoke(
      'user-api-settings-set',
      patch,
    ) as Promise<UserApiSettingsPublic>,
  searchStockVideos: (query: string) =>
    ipcRenderer.invoke('stock-search-videos', query),
  prefetchStockVideoCache: (videos: UnifiedStockVideo[], concurrency?: number) =>
    ipcRenderer.invoke('stock-prefetch-video-cache', { videos, concurrency }),
  prefetchStockVideoCacheTiered: (payload: {
    fullVideos: UnifiedStockVideo[]
    previewVideos: UnifiedStockVideo[]
    concurrencyFull?: number
    concurrencyPreview?: number
  }) =>
    ipcRenderer.invoke('stock-prefetch-video-cache-tiered', payload),
  stockCacheResolvePlayUrl: (video: UnifiedStockVideo) =>
    ipcRenderer.invoke('stock-cache-resolve-play-url', video) as Promise<{
      url: string
      kind: 'full' | 'preview' | 'remote'
    }>,
  stockCacheEnsureFull: (video: UnifiedStockVideo) =>
    ipcRenderer.invoke('stock-cache-ensure-full', video) as Promise<{
      url: string
      kind: 'full' | 'preview' | 'remote'
    }>,
  searchStockForSegment: (payload: {
    narrationZh: string
    queries: string[]
    shotDescriptionEn?: string | null
    mustIncludeEn?: string[]
    avoidSubjectsEn?: string[]
  }) => ipcRenderer.invoke('stock-search-smart', payload),
  segmentForVoiceOver: (fullText: string) =>
    ipcRenderer.invoke('dashscope-segment-voiceover', fullText),
  generateVisualStockQueries: (payload: {
    chineseLine: string
    visualHintEn?: string | null
  }) => ipcRenderer.invoke('dashscope-visual-stock-queries', payload),
  synthesizeDoubaoTts: (
    payload:
      | string
      | {
          text: string
          resourceId?: string
          speaker?: string
        },
  ) => ipcRenderer.invoke('doubao-tts', payload),
  getDoubaoTtsEnvDefaults: () =>
    ipcRenderer.invoke('doubao-tts-env-defaults') as Promise<{
      resourceId: string
      speaker: string
    }>,
  generateJimengSegmentVideo: (payload: {
    narrationZh: string
    shotDescriptionEn?: string | null
    visualHintEn?: string | null
    mustIncludeEn?: string[]
    avoidSubjectsEn?: string[]
    stockQueriesEn?: string[]
    tts: { resourceId: string; speaker: string }
    segmentIndex?: number
  }) =>
    ipcRenderer.invoke('jimeng-generate-segment-video', payload) as Promise<{
      video: UnifiedStockVideo
      voiceDurationSec: number
      chosenGenDurationSec: number
    }>,
  exportNarratedVideo: (payload: {
    segments: Array<{ narrationText: string; video: UnifiedStockVideo }>
    tts: { resourceId: string; speaker: string }
  }) =>
    ipcRenderer.invoke(
      'export-narrated-video',
      payload,
    ) as Promise<
      | { canceled: true }
      | { canceled: false; outputPath: string }
    >,
  exportJianyingProject: (payload: {
    segments: Array<{ narrationText: string; video: UnifiedStockVideo }>
    tts: { resourceId: string; speaker: string }
  }) =>
    ipcRenderer.invoke(
      'export-jianying-project',
      payload,
    ) as Promise<
      | { canceled: true }
      | { canceled: false; outputPath: string }
    >,
  showItemInFolder: (fullPath: string) =>
    ipcRenderer.invoke('show-item-in-folder', fullPath),
  /** 订阅导出进度；返回取消订阅函数 */
  onExportVideoProgress: (callback: (p: ExportVideoProgress) => void) => {
    const channel = 'export-video-progress'
    const listener = (
      _evt: Electron.IpcRendererEvent,
      p: ExportVideoProgress,
    ) => callback(p)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onJianyingExportProgress: (callback: (p: ExportVideoProgress) => void) => {
    const channel = 'jianying-export-progress'
    const listener = (
      _evt: Electron.IpcRendererEvent,
      p: ExportVideoProgress,
    ) => callback(p)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onJimengVideoProgress: (callback: (p: JimengVideoProgress) => void) => {
    const channel = 'jimeng-video-progress'
    const listener = (
      _evt: Electron.IpcRendererEvent,
      p: JimengVideoProgress,
    ) => callback(p)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
})

contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },

  // You can expose other APTs you need here.
  // ...
})

// --------- Preload scripts loading ---------
function domReady(condition: DocumentReadyState[] = ['complete', 'interactive']) {
  return new Promise(resolve => {
    if (condition.includes(document.readyState)) {
      resolve(true)
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true)
        }
      })
    }
  })
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find(e => e === child)) {
      return parent.appendChild(child)
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find(e => e === child)) {
      return parent.removeChild(child)
    }
  },
}

/**
 * https://tobiasahlin.com/spinkit
 * https://connoratherton.com/loaders
 * https://projects.lukehaas.me/css-loaders
 * https://matejkustec.github.io/SpinThatShit
 */
function useLoading() {
  const className = `loaders-css__square-spin`
  const styleContent = `
@keyframes square-spin {
  25% { transform: perspective(100px) rotateX(180deg) rotateY(0); }
  50% { transform: perspective(100px) rotateX(180deg) rotateY(180deg); }
  75% { transform: perspective(100px) rotateX(0) rotateY(180deg); }
  100% { transform: perspective(100px) rotateX(0) rotateY(0); }
}
.${className} > div {
  animation-fill-mode: both;
  width: 50px;
  height: 50px;
  background: #fff;
  animation: square-spin 3s 0s cubic-bezier(0.09, 0.57, 0.49, 0.9) infinite;
}
.app-loading-wrap {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #282c34;
  z-index: 9;
}
    `
  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  oDiv.innerHTML = `<div class="${className}"><div></div></div>`

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
    },
    removeLoading() {
      safeDOM.remove(document.head, oStyle)
      safeDOM.remove(document.body, oDiv)
    },
  }
}

// ----------------------------------------------------------------------

const { appendLoading, removeLoading } = useLoading()
domReady().then(appendLoading)

window.onmessage = (ev) => {
  ev.data.payload === 'removeLoading' && removeLoading()
}

setTimeout(removeLoading, 4999)