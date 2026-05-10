/**
 * 将每段口播（豆包 TTS）与对应预览视频用 ffmpeg 对齐时长后串联为一条 MP4。
 * 时长以语音为准：优先用 ffprobe 读取 MP3 时长并 -t 裁剪；若无 ffprobe 则回退 -shortest。
 * 各段并行（EXPORT_SEGMENT_CONCURRENCY，默认 8，最大 16）；每段内「下载画面 + 豆包 TTS」并行以缩短等待。
 * macOS 默认 h264_videotoolbox 硬件编码；可用 EXPORT_FFMPEG_SOFTWARE=1 强制软编。
 * 提速：EXPORT_BURN_SUBTITLES=0 跳过烧录字幕（显著减轻每段编码）；EXPORT_SEGMENT_OUT_W/H 降低分辨率；
 * EXPORT_SEGMENT_CONCURRENCY 提高段级并发（注意带宽、CPU 与豆包限流）。
 * EXPORT_MATERIAL_DOWNLOAD_CONCURRENCY：全局限制「成片 HTTPS 下载」同时进行的数量（默认 3），与段并行解耦，减轻多路抢带宽 / CDN 限流。
 * 字幕：与用户提交的该段口播文案一致（单条 SRT 铺满该段时长）；
 * 长句在写入前按画幅与边距做视觉宽度折行，避免无空格中文整行撑出画面。
 */

import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { UnifiedStockVideo } from '../../src/types/stockVideo'
import type {
  ExportSegmentTiming,
  ExportVideoProgress,
} from '../../src/types/exportVideo'
import { AsyncSemaphore } from '../../src/lib/asyncSemaphore'
import { mapPool } from '../../src/lib/mapPool'
import { synthesizeDoubaoTtsMp3Base64 } from './doubaoTts'
import { materializeStockVideoForSegment } from './stockVideoCache'
import { resolveStockDownloadUrl } from './stockVideoUrls'

const require = createRequire(import.meta.url)

function resolveFfmpegPath(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim()
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  try {
    const p = require('ffmpeg-static') as string | null | undefined
    if (p && fs.existsSync(p)) return p
  } catch {
    /* optional dependency */
  }
  return 'ffmpeg'
}

/** 与 ffmpeg 同目录则一并使用；也可单独设置 FFPROBE_PATH */
export function resolveFfprobePath(): string {
  const fromEnv = process.env.FFPROBE_PATH?.trim()
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const ffm = resolveFfmpegPath()
  const dir = path.dirname(ffm)
  const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const sibling = path.join(dir, name)
  if (fs.existsSync(sibling)) return sibling
  return 'ffprobe'
}

function toConcatFileLine(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return `file '${normalized.replace(/'/g, "'\\''")}'`
}

/** 读取音频时长（秒），失败返回 null */
export async function probeAudioDurationSeconds(
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

const SRT_END_EPS = 0.04

/** 单字在 16px 级字幕下的“半角宽度”权重：CJK 约等宽占双份，拉丁与标点占一份 */
function charSubtitleVisualWeight(ch: string): number {
  const cp = ch.codePointAt(0)!
  if (cp >= 0x4e00 && cp <= 0x9fff) return 2
  if (cp >= 0x3400 && cp <= 0x4dbf) return 2
  if (cp >= 0xf900 && cp <= 0xfaff) return 2
  if (cp >= 0x3040 && cp <= 0x30ff) return 2
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2
  if (cp >= 0x3000 && cp <= 0x303f) return 2
  if (cp >= 0xff00 && cp <= 0xffef) return 2
  return 1
}

/** 与 force_style 左右边距默认一致；可用 STORY_STOCK_SUBTITLE_MARGIN_LR 覆盖（16～200，像素） */
function defaultSubtitleMarginLRpx(): number {
  const raw = process.env.STORY_STOCK_SUBTITLE_MARGIN_LR?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 16 && n <= 200) return n
  /** 略贴边仍留安全区（描边/抗锯齿）；愈小愈「拉满」横向宽度 */
  return 36
}

/**
 * SRT 硬换行的「半角宽度」预算（与 charSubtitleVisualWeight 一致）。
 * 未配置 env 时按成片宽度与左右边距推算，使折行与 MarginL/R 内可视区域大致对齐，避免过窄默认导致过早换行。
 */
function subtitleLineMaxVisualWidth(): number {
  const raw = process.env.STORY_STOCK_SUBTITLE_LINE_MAX_WIDTH?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 16 && n <= 120) return n

  const { w } = segmentOutDimensions()
  const m = defaultSubtitleMarginLRpx()
  const usablePx = Math.max(400, w - 2 * m)
  /** 与 Margin 内像素宽度对齐略放宽（除数愈小则单行字数愈多）；仍 cap 防极端分辨率溢出 */
  const derived = Math.round(usablePx / 18)
  return Math.min(120, Math.max(32, derived))
}

/**
 * 在硬换行处切行，使 libass 在 MarginL/R 内不必依赖空格分词（中文长句无空格时也能收在屏内）。
 */
function wrapCaptionForDisplay(userText: string, maxVisualWidth: number): string {
  const normalized = userText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = normalized.split('\n')
  const out: string[] = []
  for (const block of blocks) {
    if (block.length === 0) {
      out.push('')
      continue
    }
    out.push(wrapOneCaptionLineBlock(block, maxVisualWidth))
  }
  return out.join('\n')
}

function wrapOneCaptionLineBlock(text: string, maxW: number): string {
  const lines: string[] = []
  let line = ''
  let w = 0
  for (const ch of text) {
    const cw = charSubtitleVisualWeight(ch)
    if (w + cw > maxW && line.length > 0) {
      lines.push(line)
      line = ch
      w = cw
    } else {
      line += ch
      w += cw
    }
  }
  if (line.length > 0) lines.push(line)
  return lines.join('\n')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** SRT 时间轴 00:00:00,000 */
function formatSrtTs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const ms = Math.min(999, Math.round((seconds % 1) * 1000))
  let s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  s %= 3600
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)},${String(ms).padStart(3, '0')}`
}

/**
 * 单条字幕覆盖整段时长；正文与用户一致（CRLF→LF），用户手工换行保留；
 * 超长行再按画幅宽度自动折行，避免横溢出屏。
 */
export function writeUserSubmittedSrt(
  outPath: string,
  userText: string,
  durationSec: number,
): void {
  const dur = Math.max(SRT_END_EPS * 2, durationSec)
  const normalized = userText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const wrapped = wrapCaptionForDisplay(
    normalized,
    subtitleLineMaxVisualWidth(),
  )
  const bodyLines = wrapped.split('\n')
  const lines: string[] = [
    '1',
    `${formatSrtTs(0)} --> ${formatSrtTs(dur)}`,
    ...bodyLines,
    '',
  ]
  fs.writeFileSync(outPath, lines.join('\n'), { encoding: 'utf8' })
}

/** 文案里出现东亚/中日韩相关码位时用「中日韩」字幕字体；否则用拉丁字体（便于英文明晰显示） */
function needsEastAsianCaptionFont(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x4e00 && cp <= 0x9fff) return true
    if (cp >= 0x3400 && cp <= 0x4dbf) return true
    if (cp >= 0xf900 && cp <= 0xfaff) return true
    if (cp >= 0x3040 && cp <= 0x30ff) return true
    if (cp >= 0xac00 && cp <= 0xd7a3) return true
    if (cp >= 0x3000 && cp <= 0x303f) return true
    if (cp >= 0xff00 && cp <= 0xffef) return true
  }
  return false
}

function pickSubtitleFontForUserText(userText: string): string {
  const overrideAll = process.env.STORY_STOCK_SUBTITLE_FONT?.trim()
  if (overrideAll) return overrideAll

  const wantEa = needsEastAsianCaptionFont(userText)
  if (wantEa) {
    const cjk = process.env.STORY_STOCK_SUBTITLE_FONT_CJK?.trim()
    if (cjk) return cjk
    if (process.platform === 'darwin') return 'PingFang SC'
    if (process.platform === 'win32') return 'Microsoft YaHei'
    return 'Noto Sans CJK SC'
  }

  const lat = process.env.STORY_STOCK_SUBTITLE_FONT_LATIN?.trim()
  if (lat) return lat
  if (process.platform === 'darwin') return 'Helvetica Neue'
  if (process.platform === 'win32') return 'Segoe UI'
  return 'DejaVu Sans'
}

/** subtitles 滤镜 force_style 内逗号需转义为 \, */
function defaultSubtitleForceStyle(userText: string): string {
  const font = pickSubtitleFontForUserText(userText)
  const size =
    process.env.STORY_STOCK_SUBTITLE_SIZE?.trim() || '16'
  /**
   * ASS 底部对齐时：MarginV 为画面底边到字幕底边的距离；数值越小越贴近屏幕最底。
   * MarginL/R 与默认折行宽度联动（见 subtitleLineMaxVisualWidth）；过大时左右留白多、易显得字幕「挤在中间」。
   */
  const marginLR = String(defaultSubtitleMarginLRpx())
  const marginV =
    process.env.STORY_STOCK_SUBTITLE_MARGIN_V?.trim() || '14'
  const parts = [
    `FontName=${font}`,
    `Fontsize=${size}`,
    /* 白字 + 黑描边；BorderStyle=1 无底框背景（不用 3 的整块底色） */
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H00000000',
    'BorderStyle=1',
    'Outline=2',
    'Shadow=1',
    /* Alignment=2：水平居中、垂直底部 */
    'Alignment=2',
    `MarginL=${marginLR}`,
    `MarginR=${marginLR}`,
    `MarginV=${marginV}`,
    /* 行距略增，多行堆叠时不互相挤压 */
    'LineSpacing=9',
    /* 行尾贴边即换行；与 SRT 内显式换行一起约束在屏内 */
    'WrapStyle=1',
  ]
  return parts.join('\\,')
}

function segmentFps(): string {
  const raw = process.env.EXPORT_SEGMENT_FPS?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 15 && n <= 60) return String(n)
  return '24'
}

/** 成片画布尺寸；降低宽高可明显加快编码（默认 1280×720） */
function segmentOutDimensions(): { w: number; h: number } {
  const defW = 1280
  const defH = 720
  const rw = parseInt(process.env.EXPORT_SEGMENT_OUT_W?.trim() ?? '', 10)
  const rh = parseInt(process.env.EXPORT_SEGMENT_OUT_H?.trim() ?? '', 10)
  const w =
    Number.isFinite(rw) && rw >= 640 && rw <= 1920 ? Math.floor(rw) : defW
  const h =
    Number.isFinite(rh) && rh >= 360 && rh <= 1080 ? Math.floor(rh) : defH
  return { w, h }
}

function burnSubtitlesInExport(): boolean {
  return process.env.EXPORT_BURN_SUBTITLES !== '0'
}

function buildSegmentVideoFilter(
  srtBasename: string | null,
  /** 用于按语种选择字体；无字幕时不使用 */
  captionSampleText: string,
): string {
  const { w, h } = segmentOutDimensions()
  const fps = segmentFps()
  const base = `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`
  if (!srtBasename || !burnSubtitlesInExport()) return base
  const style = defaultSubtitleForceStyle(captionSampleText)
  return `${base},subtitles=${srtBasename}:charenc=UTF-8:force_style=${style}`
}

/** macOS 默认硬件编码；EXPORT_FFMPEG_SOFTWARE=1 或未启用时回退 libx264 */
function exportVideoCodecArgs(): string[] {
  const forceSw = process.env.EXPORT_FFMPEG_SOFTWARE === '1'
  if (!forceSw && process.platform === 'darwin') {
    const br = process.env.EXPORT_VTB_BITRATE?.trim() || '10M'
    return ['-c:v', 'h264_videotoolbox', '-b:v', br, '-allow_sw', '1']
  }
  const preset = process.env.EXPORT_FFMPEG_PRESET?.trim() || 'veryfast'
  const crf = process.env.EXPORT_FFMPEG_CRF?.trim() || '24'
  return ['-c:v', 'libx264', '-preset', preset, '-crf', crf, '-row-mt', '1']
}

function exportSegmentConcurrency(): number {
  const raw = process.env.EXPORT_SEGMENT_CONCURRENCY?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 1 && n <= 16) return n
  return 8
}

/** 导出时同时进行 HTTPS 成片下载的上限（默认 3；与 EXPORT_SEGMENT_CONCURRENCY 独立，缓解带宽摊薄） */
function exportMaterialDownloadConcurrency(): number {
  const raw = process.env.EXPORT_MATERIAL_DOWNLOAD_CONCURRENCY?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 1 && n <= 16) return n
  return 3
}

/** 单段豆包 TTS 超时（毫秒），默认 3 分钟 */
function exportTtsTimeoutMs(): number {
  const raw = process.env.EXPORT_TTS_TIMEOUT_MS?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 30_000 && n <= 600_000) return n
  return 180_000
}

/** 单段 ffmpeg 编码超时（毫秒），0 表示不限制；默认 0 */
function exportFfmpegSegmentTimeoutMs(): number {
  const raw = process.env.EXPORT_FFMPEG_SEGMENT_TIMEOUT_MS?.trim()
  const n = raw ? parseInt(raw, 10) : NaN
  if (Number.isFinite(n) && n >= 60_000) return n
  return 0
}

function promiseWithTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `${label} 超时（约 ${Math.round(ms / 1000)}s）。可在 .env 调整 EXPORT_TTS_TIMEOUT_MS`,
        ),
      )
    }, ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** 写入 *.export-timing.json 时的字段说明（避免把 sums 当成总耗时） */
const EXPORT_TIMING_README =
  'wallTotalMs：从开始导出到写完成片文件的总墙钟（毫秒），可与体感对照。' +
  'sums：把每一段上的 materializeMs、ttsMs、probeAndSrtMs、ffmpegMs、totalMs 分别做算术相加；因默认多段并行(exportSegmentConcurrency)，且同一段内「下载素材」与「豆包配音」并行，故 sums 往往远大于 wallTotalMs，不代表顺序排队累加，也不是程序算错。' +
  '单段内的 materializeMs 与 ttsMs 亦为并行测量，二者相加大于该段真实墙钟属正常。' +
  'materializeMs 含「等待成片下载槽位」与真实传输；exportMaterialDownloadConcurrency 限制全局同时下载条数，减轻多路 HTTPS 抢带宽。'

function runFfmpeg(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<void> {
  const bin = resolveFfmpegPath()
  return new Promise((resolve, reject) => {
    const ff = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    })
    let err = ''
    ff.stderr?.on('data', (d: Buffer) => {
      err += d.toString()
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs != null && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          ff.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            `ffmpeg 编码超时（约 ${Math.round(timeoutMs / 1000)}s）。可增大 EXPORT_FFMPEG_SEGMENT_TIMEOUT_MS 或降低 EXPORT_SEGMENT_CONCURRENCY`,
          ),
        )
      }, timeoutMs)
    }
    ff.on('error', (e) => {
      if (timer) clearTimeout(timer)
      reject(
        new Error(
          `无法启动 ffmpeg（${bin}）。请安装 ffmpeg、配置 FFMPEG_PATH，或执行 npm install ffmpeg-static。 ${e.message}`,
        ),
      )
    })
    ff.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 失败 (${code}): ${err.slice(-1600)}`))
    })
  })
}

export async function exportNarratedVideoFile(options: {
  segments: Array<{ narrationText: string; video: UnifiedStockVideo }>
  ttsApiKey: string
  ttsResourceId: string
  ttsSpeaker: string
  outputFile: string
  onProgress?: (e: ExportVideoProgress) => void
}): Promise<void> {
  const {
    segments,
    ttsApiKey,
    ttsResourceId,
    ttsSpeaker,
    outputFile,
    onProgress,
  } = options

  if (segments.length === 0) throw new Error('没有分段')

  const pool = exportSegmentConcurrency()
  const downloadSlots = exportMaterialDownloadConcurrency()
  const materialDownloadSem = new AsyncSemaphore(downloadSlots)
  const vcodec = exportVideoCodecArgs()
  const { w: outW, h: outH } = segmentOutDimensions()
  const burnSub = burnSubtitlesInExport()

  onProgress?.({
    percent: 0,
    label: '准备导出',
    detail: `共 ${segments.length} 段 · 段并行 ${pool} · 成片下载并发 ${downloadSlots} · 画布 ${outW}×${outH}${burnSub ? ' · 烧录字幕' : ' · 无字幕烧录（更快）'}`,
  })

  const work = path.join(os.tmpdir(), `story-stock-export-${randomUUID()}`)
  fs.mkdirSync(work, { recursive: true })

  let finishedSegments = 0
  /** 单调时钟，用于墙钟总耗时（避免与 Date 系统校时混淆） */
  const exportT0 = performance.now()
  const segmentTimings: ExportSegmentTiming[] = []

  const finishProgress = (
    concatMs: number,
    timingPath: string | null,
    wallTotalMs: number,
  ): void => {
    const sums = segmentTimings.reduce(
      (acc, t) => ({
        materializeMs: acc.materializeMs + t.materializeMs,
        ttsMs: acc.ttsMs + t.ttsMs,
        probeAndSrtMs: acc.probeAndSrtMs + t.probeAndSrtMs,
        ffmpegMs: acc.ffmpegMs + t.ffmpegMs,
        totalMs: acc.totalMs + t.totalMs,
      }),
      {
        materializeMs: 0,
        ttsMs: 0,
        probeAndSrtMs: 0,
        ffmpegMs: 0,
        totalMs: 0,
      },
    )
    const sec = (ms: number) => (ms / 1000).toFixed(1)
    const summary =
      `本次导出墙钟约 ${sec(wallTotalMs)}（以此为准）。下列为各环节「各段数值相加」仅供分项参考：多段并行时相加会远大于墙钟，不等于排队累加。` +
      `拉取素材 ${sec(sums.materializeMs)}s · 豆包配音 ${sec(sums.ttsMs)}s · 探针与字幕 ${sec(sums.probeAndSrtMs)}s · 分段编码 ${sec(sums.ffmpegMs)}s${concatMs > 0 ? ` · 合并 ${sec(concatMs)}s` : ''}${timingPath ? ` · 明细 ${timingPath}` : ''}`
    onProgress?.({
      percent: 100,
      label: '导出完成',
      detail: outputFile,
      segmentTimings,
      concatMs: concatMs > 0 ? concatMs : undefined,
      timingSummary: summary,
    })
  }

  try {
    const partPaths = await mapPool(segments, pool, async (seg, i) => {
      const idx = String(i + 1).padStart(3, '0')
      const vPath = path.join(work, `v-${idx}.mp4`)
      const aPath = path.join(work, `a-${idx}.mp3`)
      const oPath = path.join(work, `part-${idx}.mp4`)
      const segWall0 = Date.now()
      let materializeMs = 0
      let ttsMs = 0

      onProgress?.({
        percent: Math.min(
          30,
          2 + Math.round((i / Math.max(1, segments.length)) * 28),
        ),
        label: `导出中：第 ${i + 1}/${segments.length} 段`,
        detail: '正在下载素材并生成配音…',
      })

      const ffTimeout = exportFfmpegSegmentTimeoutMs()

      try {
        await Promise.all([
          (async () => {
            const t0 = Date.now()
            await materialDownloadSem.acquire()
            try {
              await materializeStockVideoForSegment(seg.video, vPath)
            } finally {
              materialDownloadSem.release()
            }
            materializeMs = Date.now() - t0
          })(),
          (async () => {
            const t0 = Date.now()
            const b64 = await promiseWithTimeout(
              synthesizeDoubaoTtsMp3Base64({
                apiKey: ttsApiKey,
                resourceId: ttsResourceId,
                speaker: ttsSpeaker,
                text: seg.narrationText.trim(),
              }),
              exportTtsTimeoutMs(),
              '豆包配音',
            )
            fs.writeFileSync(aPath, Buffer.from(b64, 'base64'))
            ttsMs = Date.now() - t0
          })(),
        ])
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(`第 ${i + 1} 段素材或配音失败：${msg}`)
      }

      const probe0 = Date.now()
      const audioDur = await probeAudioDurationSeconds(aPath)

      const durationTail =
        audioDur != null && audioDur > 0
          ? (['-t', audioDur.toFixed(4)] as const)
          : (['-shortest'] as const)

      const narrationZh = seg.narrationText ?? ''
      const subDur =
        audioDur != null && audioDur > 0 ? audioDur : 60
      let subBasename: string | null = null
      if (narrationZh.length > 0) {
        subBasename = `sub-${idx}.srt`
        writeUserSubmittedSrt(path.join(work, subBasename), narrationZh, subDur)
      }
      const probeAndSrtMs = Date.now() - probe0

      const vf = buildSegmentVideoFilter(subBasename, narrationZh)
      const ff0 = Date.now()
      await runFfmpeg(
        [
          '-y',
          '-stream_loop',
          '-1',
          '-i',
          path.basename(vPath),
          '-i',
          path.basename(aPath),
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-vf',
          vf,
          ...vcodec,
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          ...durationTail,
          '-pix_fmt',
          'yuv420p',
          path.basename(oPath),
        ],
        work,
        ffTimeout > 0 ? ffTimeout : undefined,
      )
      const ffmpegMs = Date.now() - ff0

      const vid = seg.video
      const downloadUrl =
        resolveStockDownloadUrl(vid).trim() ||
        vid.previewVideoUrl?.trim() ||
        ''
      segmentTimings[i] = {
        segmentIndex: i + 1,
        videoKey: vid.key,
        videoSource: vid.source,
        pageUrl: vid.pageUrl?.trim() ?? '',
        downloadUrl,
        materializeMs,
        ttsMs,
        probeAndSrtMs,
        ffmpegMs,
        totalMs: Date.now() - segWall0,
      }

      finishedSegments++
      const pct = Math.min(
        94,
        Math.round((finishedSegments / segments.length) * 92),
      )
      onProgress?.({
        percent: pct,
        label: `导出中：已完成 ${finishedSegments}/${segments.length} 段`,
        detail:
          audioDur != null
            ? `第 ${i + 1} 段 · 输出时长 ${audioDur.toFixed(2)} 秒`
            : `第 ${i + 1} 段 · 已对齐（建议安装 ffprobe 以精确按语音裁剪）`,
      })

      return oPath
    })

    const partFiles = partPaths
    const parsedOut = path.parse(outputFile)
    const timingPath = path.join(
      parsedOut.dir,
      `${parsedOut.name}.export-timing.json`,
    )

    if (partFiles.length === 1) {
      onProgress?.({ percent: 97, label: '正在写入成片文件…', detail: outputFile })
      fs.copyFileSync(partFiles[0]!, outputFile)
      const wallTotalMs = Math.round(performance.now() - exportT0)
      fs.writeFileSync(
        timingPath,
        `${JSON.stringify(
          {
            outputFile,
            wallTotalMs,
            exportSegmentConcurrency: pool,
            exportMaterialDownloadConcurrency: downloadSlots,
            timingReadme: EXPORT_TIMING_README,
            note: '同段内 download∥TTS；多段并行；成片下载受 exportMaterialDownloadConcurrency 限制。详见 timingReadme；勿把 sums 当总耗时。',
            segmentTimings,
            sums: segmentTimings.reduce(
              (acc, t) => ({
                materializeMs: acc.materializeMs + t.materializeMs,
                ttsMs: acc.ttsMs + t.ttsMs,
                probeAndSrtMs: acc.probeAndSrtMs + t.probeAndSrtMs,
                ffmpegMs: acc.ffmpegMs + t.ffmpegMs,
                totalMs: acc.totalMs + t.totalMs,
              }),
              {
                materializeMs: 0,
                ttsMs: 0,
                probeAndSrtMs: 0,
                ffmpegMs: 0,
                totalMs: 0,
              },
            ),
            concatMs: 0,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      finishProgress(0, timingPath, wallTotalMs)
      return
    }

    const listPath = path.join(work, 'concat.txt')
    fs.writeFileSync(
      listPath,
      partFiles.map((p) => toConcatFileLine(path.resolve(p))).join('\n'),
      'utf8',
    )

    onProgress?.({
      percent: 96,
      label: '正在合并全部片段…',
      detail: `${partFiles.length} 段 → 一条成片`,
    })

    const concat0 = performance.now()
    try {
      await runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c',
        'copy',
        outputFile,
      ])
    } catch {
      await runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        ...exportVideoCodecArgs(),
        '-c:a',
        'aac',
        outputFile,
      ])
    }
    const concatMs = Math.round(performance.now() - concat0)
    const wallTotalMs = Math.round(performance.now() - exportT0)
    fs.writeFileSync(
      timingPath,
      `${JSON.stringify(
        {
          outputFile,
          wallTotalMs,
          exportSegmentConcurrency: pool,
          exportMaterialDownloadConcurrency: downloadSlots,
          timingReadme: EXPORT_TIMING_README,
          note: '同段内 download∥TTS；多段并行；成片下载受 exportMaterialDownloadConcurrency 限制。详见 timingReadme；勿把 sums 当总耗时。',
          segmentTimings,
          sums: segmentTimings.reduce(
            (acc, t) => ({
              materializeMs: acc.materializeMs + t.materializeMs,
              ttsMs: acc.ttsMs + t.ttsMs,
              probeAndSrtMs: acc.probeAndSrtMs + t.probeAndSrtMs,
              ffmpegMs: acc.ffmpegMs + t.ffmpegMs,
              totalMs: acc.totalMs + t.totalMs,
            }),
            {
              materializeMs: 0,
              ttsMs: 0,
              probeAndSrtMs: 0,
              ffmpegMs: 0,
              totalMs: 0,
            },
          ),
          concatMs,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    finishProgress(concatMs, timingPath, wallTotalMs)
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
