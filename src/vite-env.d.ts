/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 本地分段单段最大字数（24～120），不设则默认 52 */
  readonly VITE_MAX_CHARS_PER_SEGMENT?: string
  /** 本地分段单段最短字数（8～48），过短会与邻段合并；不设则默认 18 */
  readonly VITE_MIN_SEGMENT_CHARS?: string
  /** 多段并行拉素材/生成检索词时的最大并发数（1～32，默认 6） */
  readonly VITE_STOCK_SEARCH_CONCURRENCY?: string
  /** 候选成片后台缓存到本机的并发数（1～32，默认 8；主进程 STOCK_CACHE_MAX_CONCURRENCY 可收紧上限） */
  readonly VITE_STOCK_CACHE_CONCURRENCY?: string
  /** 试用结束后引导充值的账户页 URL（默认 https://aiganhuole.com/account） */
  readonly VITE_AUTH_ACCOUNT_URL?: string
}

import type { IpcRenderer } from 'electron'
import type { ExportVideoProgress } from './types/exportVideo'
import type { JimengVideoProgress } from './types/jimengVideo'
import type { StockSearchResponse, UnifiedStockVideo } from './types/stockVideo'
import type { SegmentVoiceOverResult } from './types/segment'
import type { VisualStockQueriesResult } from './types/visualQuery'
import type {
  UserApiSettingsPatch,
  UserApiSettingsPublic,
} from './types/userApiSettings'
import type { AuthUser } from './types/auth'
import type {
  UsagePublicStatus,
  UsagePurchaseDaysResult,
} from './types/usage'

declare global {
  interface Window {
    ipcRenderer: IpcRenderer
    storyStock: {
      usageSyncStatus?: () => Promise<UsagePublicStatus>
      usagePurchaseDays?: (
        days: number,
      ) => Promise<UsagePurchaseDaysResult>
      authLogin: (payload: {
        email: string
        password: string
      }) => Promise<AuthUser>
      authLogout: () => Promise<void>
      authGetState: () => Promise<{
        loggedIn: boolean
        user?: AuthUser
      }>
      openAuthRegisterPage: () => Promise<void>
      openExternalUrl: (url: string) => Promise<void>
      getUserApiSettings: () => Promise<UserApiSettingsPublic>
      setUserApiSettings: (
        patch: UserApiSettingsPatch,
      ) => Promise<UserApiSettingsPublic>
      searchStockVideos: (query: string) => Promise<StockSearchResponse>
      prefetchStockVideoCache: (
        videos: UnifiedStockVideo[],
        concurrency?: number,
      ) => Promise<void>
      prefetchStockVideoCacheTiered?: (payload: {
        fullVideos: UnifiedStockVideo[]
        previewVideos: UnifiedStockVideo[]
        concurrencyFull?: number
        concurrencyPreview?: number
      }) => Promise<void>
      stockCacheResolvePlayUrl?: (video: UnifiedStockVideo) => Promise<{
        url: string
        kind: 'full' | 'preview' | 'remote'
      }>
      stockCacheEnsureFull?: (video: UnifiedStockVideo) => Promise<{
        url: string
        kind: 'full' | 'preview' | 'remote'
      }>
      searchStockForSegment: (payload: {
        narrationZh: string
        queries: string[]
        shotDescriptionEn?: string | null
        mustIncludeEn?: string[]
        avoidSubjectsEn?: string[]
      }) => Promise<StockSearchResponse>
      segmentForVoiceOver: (fullText: string) => Promise<SegmentVoiceOverResult>
      generateVisualStockQueries: (payload: {
        chineseLine: string
        visualHintEn?: string | null
      }) => Promise<VisualStockQueriesResult>
      synthesizeDoubaoTts: (
        payload:
          | string
          | {
              text: string
              resourceId?: string
              speaker?: string
            },
      ) => Promise<{
        mimeType: 'audio/mpeg'
        base64: string
      }>
      getDoubaoTtsEnvDefaults: () => Promise<{
        resourceId: string
        speaker: string
      }>
      generateJimengSegmentVideo: (payload: {
        narrationZh: string
        shotDescriptionEn?: string | null
        visualHintEn?: string | null
        mustIncludeEn?: string[]
        avoidSubjectsEn?: string[]
        stockQueriesEn?: string[]
        tts: { resourceId: string; speaker: string }
        segmentIndex?: number
      }) => Promise<{
        video: UnifiedStockVideo
        voiceDurationSec: number
        chosenGenDurationSec: number
      }>
      exportNarratedVideo: (payload: {
        segments: Array<{ narrationText: string; video: UnifiedStockVideo }>
        tts: { resourceId: string; speaker: string }
      }) => Promise<
        | { canceled: true }
        | { canceled: false; outputPath: string }
      >
      exportJianyingProject: (payload: {
        segments: Array<{ narrationText: string; video: UnifiedStockVideo }>
        tts: { resourceId: string; speaker: string }
      }) => Promise<
        | { canceled: true }
        | { canceled: false; outputPath: string }
      >
      showItemInFolder: (fullPath: string) => Promise<void>
      onExportVideoProgress?: (
        callback: (p: ExportVideoProgress) => void,
      ) => () => void
      onJianyingExportProgress?: (
        callback: (p: ExportVideoProgress) => void,
      ) => () => void
      onJimengVideoProgress?: (
        callback: (p: JimengVideoProgress) => void,
      ) => () => void
    }
  }
}

export {}
