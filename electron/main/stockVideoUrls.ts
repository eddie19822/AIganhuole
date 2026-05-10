import type { UnifiedStockVideo } from '../../src/types/stockVideo'

/** 即梦预览可能为 jimeng-local / file；导出与缓存须用官方 https 成片地址 */
export function resolveStockDownloadUrl(v: UnifiedStockVideo): string {
  const prev = v.previewVideoUrl?.trim() ?? ''
  if (
    prev.startsWith('jimeng-local:') ||
    prev.startsWith('file:') ||
    prev.startsWith('story-video:')
  ) {
    const page = v.pageUrl?.trim()
    if (page && /^https?:\/\//i.test(page)) return page
  }
  return prev
}
