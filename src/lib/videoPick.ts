import type { PexelsVideo, PexelsVideoFile } from '@/types/pexels'
import { pickPexelsVideoFileNear1080p } from './pexelsPick'

function vitePexelsMaxLongEdge(): number {
  try {
    const raw = import.meta.env.VITE_STOCK_PEXELS_MAX_LONG_EDGE as
      | string
      | undefined
    const n = parseInt(String(raw ?? '').trim(), 10)
    if (Number.isFinite(n) && n >= 640 && n <= 4096) return n
  } catch {
    /* ignore */
  }
  return 1920
}

export function pickBestVideoFile(video: PexelsVideo): PexelsVideoFile | undefined {
  return pickPexelsVideoFileNear1080p(video.video_files, {
    maxLongEdgePx: vitePexelsMaxLongEdge(),
  })
}
