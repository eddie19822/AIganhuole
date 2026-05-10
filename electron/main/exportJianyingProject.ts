/**
 * 导出「剪映」可用分镜素材包：每段画面视频、豆包配音、与口播一致的 SRT 字幕，
 * 以及时间轴说明。剪映各版本工程 JSON 差异大，此方式通过「素材 + 说明」保证可导入、可维护。
 */

import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { UnifiedStockVideo } from '../../src/types/stockVideo'
import type { ExportVideoProgress } from '../../src/types/exportVideo'
import { mapPool } from '../../src/lib/mapPool'
import {
  probeAudioDurationSeconds,
  resolveFfprobePath,
  writeUserSubmittedSrt,
} from './exportVideo'
import { materializeStockVideoForSegment } from './stockVideoCache'
import { synthesizeDoubaoTtsMp3Base64 } from './doubaoTts'

const execFileAsync = promisify(execFile)

async function probeVideoDurationSeconds(videoPath: string): Promise<number | null> {
  const probeBin = resolveFfprobePath()
  return new Promise((resolve) => {
    const child = spawn(probeBin, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      videoPath,
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

function segmentIndexPad(i: number): string {
  return String(i + 1).padStart(3, '0')
}

async function zipProjectFolder(projectRoot: string, zipOutPath: string): Promise<void> {
  try {
    fs.unlinkSync(zipOutPath)
  } catch {
    /* 不存在则忽略 */
  }
  const parent = path.dirname(projectRoot)
  const base = path.basename(projectRoot)

  if (process.platform === 'win32') {
    const litProject = path.resolve(projectRoot)
    const litZip = path.resolve(zipOutPath)
    const ps = `Compress-Archive -LiteralPath ${JSON.stringify(litProject)} -DestinationPath ${JSON.stringify(litZip)} -Force`
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
    })
    return
  }

  await execFileAsync('zip', ['-r', '-y', zipOutPath, base], {
    cwd: parent,
  })
}

function readmeZh(): string {
  return [
    '易剪 · 剪映分镜素材包',
    '',
    '本 ZIP 解压后包含：',
    '  assets/    每段对应的画面视频、配音 MP3、字幕 SRT（文件名以 001、002… 序号对齐）',
    '  timeline.json   机器可读的时间轴（累计起点、各段时长）',
    '',
    '在剪映（电脑版）中手动导入（通用流程）：',
    '1）解压本包到任意文件夹。',
    '2）打开剪映 → 新建草稿 → 分辨率建议选 1920×1080（或与素材接近）。',
    '3）媒体库 → 导入素材 → 选中 assets 文件夹内全部文件（或按需分段导入）。',
    '4）将「序号_video」文件按顺序放入主视频轨道，片段之间首尾相接。',
    '5）将同序号「序号_narration」放入音频轨道，起点与各段视频起点对齐。',
    '6）字幕：可使用「本地字幕」导入同序号「序号_subtitle.srt」，或将字幕文本复制到剪映文本轨道。',
    '',
    '说明：剪映官方工程文件格式随版本变化较大，本导出采用「音视频字幕分立文件」方式，便于兼容各版本剪映与其它剪辑软件。',
    '',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
  ].join('\r\n')
}

export async function exportJianyingProjectZip(options: {
  segments: Array<{ narrationText: string; video: UnifiedStockVideo }>
  ttsApiKey: string
  ttsResourceId: string
  ttsSpeaker: string
  outputZipPath: string
  onProgress?: (e: ExportVideoProgress) => void
}): Promise<void> {
  const {
    segments,
    ttsApiKey,
    ttsResourceId,
    ttsSpeaker,
    outputZipPath,
    onProgress,
  } = options

  if (segments.length === 0) throw new Error('没有分段')

  const pool = Math.min(6, Math.max(1, segments.length))
  const workRoot = path.join(os.tmpdir(), `yijian-jianying-${randomUUID()}`)
  const projectDir = path.join(workRoot, 'yijian_jianying_project')
  const assetsDir = path.join(projectDir, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })

  onProgress?.({
    percent: 2,
    label: '准备导出剪映素材包',
    detail: `共 ${segments.length} 段 · 下载画面并合成配音与字幕`,
  })

  interface SegMeta {
    index: number
    narrationText: string
    videoFile: string
    narrationFile: string
    subtitleFile: string
    narrationDurationSec: number | null
    videoDurationSec: number | null
    timelineStartSec: number
    timelineEndSec: number
  }

  const metas: SegMeta[] = []
  let cumulative = 0
  let done = 0

  const roundResults = await mapPool(segments, pool, async (seg, i) => {
    const idx = segmentIndexPad(i)
    const videoRel = `assets/${idx}_video.mp4`
    const narrationRel = `assets/${idx}_narration.mp3`
    const subtitleRel = `assets/${idx}_subtitle.srt`
    const videoAbs = path.join(projectDir, videoRel)
    const narrationAbs = path.join(projectDir, narrationRel)
    const subtitleAbs = path.join(projectDir, subtitleRel)

    await materializeStockVideoForSegment(seg.video, videoAbs)

    const b64 = await synthesizeDoubaoTtsMp3Base64({
      apiKey: ttsApiKey,
      resourceId: ttsResourceId,
      speaker: ttsSpeaker,
      text: seg.narrationText.trim(),
    })
    fs.writeFileSync(narrationAbs, Buffer.from(b64, 'base64'))

    const audioDur = await probeAudioDurationSeconds(narrationAbs)
    const videoDur = await probeVideoDurationSeconds(videoAbs)
    const narrationZh = seg.narrationText ?? ''
    const subDur =
      audioDur != null && audioDur > 0 ? audioDur : videoDur ?? 60
    if (narrationZh.length > 0) {
      writeUserSubmittedSrt(subtitleAbs, narrationZh, subDur)
    } else {
      fs.writeFileSync(subtitleAbs, '', { encoding: 'utf8' })
    }

    const segmentDuration =
      audioDur != null && audioDur > 0
        ? audioDur
        : videoDur != null && videoDur > 0
          ? videoDur
          : subDur

    done++
    const pct = Math.min(88, Math.round((done / segments.length) * 85) + 2)
    onProgress?.({
      percent: pct,
      label: `导出剪映包：已完成 ${done}/${segments.length} 段`,
      detail: `片段 ${idx}`,
    })

    return {
      index: i + 1,
      narrationText: seg.narrationText,
      videoFile: videoRel.replace(/\\/g, '/'),
      narrationFile: narrationRel.replace(/\\/g, '/'),
      subtitleFile: subtitleRel.replace(/\\/g, '/'),
      narrationDurationSec: audioDur,
      videoDurationSec: videoDur,
      segmentDurationSec: segmentDuration,
    }
  })

  for (const r of roundResults.sort((a, b) => a.index - b.index)) {
    const start = cumulative
    const end = cumulative + r.segmentDurationSec
    metas.push({
      index: r.index,
      narrationText: r.narrationText,
      videoFile: r.videoFile,
      narrationFile: r.narrationFile,
      subtitleFile: r.subtitleFile,
      narrationDurationSec: r.narrationDurationSec,
      videoDurationSec: r.videoDurationSec,
      timelineStartSec: start,
      timelineEndSec: end,
    })
    cumulative = end
  }

  const timeline = {
    app: '易剪',
    targetEditor: '剪映',
    formatVersion: 1,
    note: '分镜素材包：非剪映加密草稿格式；请按 README 在剪映中导入 assets 并对齐时间轴。',
    totalDurationSec: cumulative,
    segments: metas.map((m) => ({
      index: m.index,
      narrationText: m.narrationText,
      files: {
        video: m.videoFile,
        narration: m.narrationFile,
        subtitle: m.subtitleFile,
      },
      narrationDurationSec: m.narrationDurationSec,
      videoDurationSec: m.videoDurationSec,
      timelineStartSec: m.timelineStartSec,
      timelineEndSec: m.timelineEndSec,
    })),
  }

  fs.writeFileSync(
    path.join(projectDir, 'timeline.json'),
    `${JSON.stringify(timeline, null, 2)}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(projectDir, 'README.txt'), readmeZh(), 'utf8')

  onProgress?.({ percent: 92, label: '正在打包 ZIP…', detail: outputZipPath })
  await zipProjectFolder(projectDir, outputZipPath)

  try {
    fs.rmSync(workRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  onProgress?.({ percent: 100, label: '剪映素材包已保存', detail: outputZipPath })
}
