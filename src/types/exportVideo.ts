import type { UnifiedStockVideo } from './stockVideo'

/** 主进程 → 渲染进程：导出成片进度 */
export interface ExportVideoProgress {
  percent: number
  label: string
  detail?: string
  /** 各段导出环节耗时（毫秒），便于分析瓶颈 */
  segmentTimings?: ExportSegmentTiming[]
  /** 合并 concat 耗时（毫秒） */
  concatMs?: number
  /** 各段耗时汇总 + 写入 timing 文件路径 */
  timingSummary?: string
}

/** 单段导出：素材下载、配音、探针与字幕、ffmpeg 编码 */
export interface ExportSegmentTiming {
  segmentIndex: number
  /** 列表项标识，如 pexels-123、pixabay-456 */
  videoKey: string
  videoSource: UnifiedStockVideo['source']
  /** 素材详情页（便于浏览器打开核对） */
  pageUrl: string
  /** 本段 materialize 实际使用的下载/缓存 URL（经 resolveStockDownloadUrl，可能与 previewVideoUrl 不同） */
  downloadUrl: string
  materializeMs: number
  ttsMs: number
  probeAndSrtMs: number
  ffmpegMs: number
  totalMs: number
}
