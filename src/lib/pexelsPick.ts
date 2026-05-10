import type { PexelsVideoFile } from '@/types/pexels'

function longEdge(w: number, h: number): number {
  return Math.max(w ?? 0, h ?? 0)
}

function isVideoLikeFile(f: PexelsVideoFile): boolean {
  const q = (f.quality ?? '').toLowerCase()
  if (q === 'hls') return false
  const ft = (f.file_type ?? '').toLowerCase()
  if (ft.includes('mpegurl') || ft.includes('m3u8')) return false
  return (
    ft.includes('video') ||
    ft === 'mp4' ||
    ft.endsWith('/mp4') ||
    /\.(mp4|webm|mov)(\b|$)/i.test(ft)
  )
}

/**
 * 默认按 **约 1080p** 选档：长边 ≤ maxLongEdgePx 中取质量最高的一档；
 * 若只有高于该分辨率的资源，则取长边**最小**的一档（避免默认拉 4K UHD）。
 *
 * 可用 `STOCK_PEXELS_MAX_LONG_EDGE`（主进程）或 `VITE_STOCK_PEXELS_MAX_LONG_EDGE`（渲染层）覆盖，单位像素，建议 1280～1920。
 */
export function pickPexelsVideoFileNear1080p(
  files: PexelsVideoFile[] | undefined,
  options?: { maxLongEdgePx?: number },
): PexelsVideoFile | undefined {
  const maxEdge = options?.maxLongEdgePx ?? 1920
  const raw = files?.filter((f) => f.link) ?? []
  if (raw.length === 0) return undefined

  const prefer = raw.filter(isVideoLikeFile)
  const pool = prefer.length > 0 ? prefer : raw.filter((f) => (f.quality ?? '').toLowerCase() !== 'hls')

  const scored = pool
    .map((f) => ({
      f,
      le: longEdge(f.width ?? 0, f.height ?? 0),
    }))
    .filter((s) => s.le > 0)

  /** 极少数条目缺失宽高时退回「仍像视频的」最高宽档 */
  if (scored.length === 0 && pool.length > 0) {
    return [...pool].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
  }
  if (scored.length === 0) return undefined

  const under = scored.filter((s) => s.le <= maxEdge)
  if (under.length > 0) {
    under.sort((a, b) => b.le - a.le)
    return under[0]?.f
  }

  scored.sort((a, b) => a.le - b.le)
  return scored[0]?.f
}
