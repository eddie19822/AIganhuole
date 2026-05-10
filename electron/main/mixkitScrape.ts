/**
 * Mixkit 素材：抓取列表页 HTML（无官方 API）。
 * 若 Mixkit 改版导致 DOM 变化，解析可能失效；请遵守 https://mixkit.co/terms/。
 */

import type { UnifiedStockVideo } from '../../src/types/stockVideo'
import { mainFetch } from './mainFetch'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 列表解析到的预览多为 360p，尝试换 720p（无效时播放器仍可退回较低清晰度来源页下载） */
function preferHdPreview(url360: string): string {
  if (url360.includes('-360.mp4')) {
    return url360.replace('-360.mp4', '-720.mp4')
  }
  if (url360.includes('-video-360.mp4')) {
    return url360.replace('-video-360.mp4', '-video-720.mp4')
  }
  return url360
}

function readAttr(openTag: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*)"`, 'i')
  const m = openTag.match(re)
  return m?.[1]
}

/** 取首个形如 <img ... class="...thumb..." ...> 或 class 在前 */
function extractImgThumb(chunk: string): { tag: string; src: string; alt: string } | null {
  const variants = [
    /<img[^>]*class="[^"]*item-grid-video-player__thumb[^"]*"[^>]*>/gi,
    /<img[^>]*class='[^']*item-grid-video-player__thumb[^']*'[^>]*>/gi,
  ]
  for (const re of variants) {
    re.lastIndex = 0
    const m = re.exec(chunk)
    if (m) {
      const tag = m[0]
      let src = readAttr(tag, 'src')
      const alt = readAttr(tag, 'alt') ?? ''
      if (!src) {
        const srcset = readAttr(tag, 'srcset')
        if (srcset) src = srcset.split(/\s+/)[0]?.trim()
      }
      if (src) return { tag, src, alt }
    }
  }
  return null
}

function extractVideoSrc(chunk: string): string | null {
  const re =
    /<video[^>]*class="[^"]*item-grid-video-player__video[^"]*"[^>]*>/gi
  re.lastIndex = 0
  const m = re.exec(chunk)
  if (!m) return null
  const src = readAttr(m[0], 'src')
  return src ?? null
}

/**
 * 从 discover / 首页列表 HTML 解析条目。
 */
export function parseMixkitListingHtml(
  html: string,
  limit: number,
): UnifiedStockVideo[] {
  const out: UnifiedStockVideo[] = []
  const parts = html.split('data-item-grid--video-player-item-id-value="')

  for (let i = 1; i < parts.length && out.length < limit; i++) {
    const chunk = parts[i] ?? ''

    const idM = /^(\d+)"/.exec(chunk)
    if (!idM) continue
    const sid = idM[1]

    const hrefMatch =
      chunk.match(/href="(\/free-stock-video\/[^"]+)"/) ??
      chunk.match(/href='(\/free-stock-video\/[^']+)'/)
    const path = hrefMatch?.[1]
    if (!path) continue

    const img = extractImgThumb(chunk)
    const videoSrc = extractVideoSrc(chunk)
    if (!img?.src || !videoSrc) continue

    const pageUrl = path.startsWith('http') ? path : `https://mixkit.co${path}`
    const slugWords = path
      .replace(/^\/free-stock-video\//, '')
      .replace(/\/$/, '')
      .replace(/-\d+\/?$/, '')
      .replace(/-/g, ' ')
    const rerankText = [img.alt, slugWords].filter(Boolean).join(' | ')

    out.push({
      source: 'mixkit',
      key: `mixkit-${sid}`,
      pageUrl,
      duration: 0,
      authorName: 'Mixkit',
      thumbnailUrl: img.src,
      previewVideoUrl: preferHdPreview(videoSrc),
      rerankText: rerankText || undefined,
    })
  }

  return out
}

export async function scrapeMixkitVideoListing(
  query: string,
  limit: number,
): Promise<UnifiedStockVideo[]> {
  const q = query.trim()
  /** 站点检索表单为 GET `/search/` + `name=s`；视频列表可用 `/free-stock-video/search/?s=`。
   * 旧版 `discover/?q=` 已不再按关键词筛选（会退回整库列表），导致检索词无效、看起来像爬取失败。 */
  const listUrl = q
    ? `https://mixkit.co/free-stock-video/search/?s=${encodeURIComponent(q)}`
    : 'https://mixkit.co/free-stock-video/'

  const res = await mainFetch(listUrl, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://mixkit.co/free-stock-video/',
    },
  })

  const html = await res.text()
  if (!res.ok) {
    throw new Error(`Mixkit 列表 HTTP ${res.status}: ${html.slice(0, 200)}`)
  }

  return parseMixkitListingHtml(html, limit)
}
